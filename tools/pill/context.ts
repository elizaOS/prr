/**
 * Assemble full PillContext: docs + source + output.log + prompts digest.
 * Output log: included in full when small (≤30k tokens and ≤100k chars); otherwise
 * head+tail+story-read middle (like tools/story). Final output log is capped in chars
 * (default 50k; PILL_OUTPUT_LOG_MAX_CHARS) to avoid 504 / FUNCTION_INVOCATION_TIMEOUT.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { PillConfig, PillContext } from './types.js';
import { DEFAULT_PILL_CONTEXT_BUDGET_TOKENS } from './config.js';
import {
  readDocFiles,
  readSourceFiles,
  readDirectoryTree,
  estimateTokens,
} from './utils/files.js';
import {
  truncateHeadAndTail,
  truncateHeadAndTailByChars,
} from '../../shared/utils/tokens.js';
import { parsePromptsLog } from './logs/parser.js';
import { processLogChapters, storyReadPlainText, type LLMClientForProcessor } from './logs/processor.js';

const SOURCE_TOKEN_BUDGET = 80_000;
/** Use head+tail+story path when log exceeds this token count (chunk earlier to avoid 504). */
const LOG_RAW_THRESHOLD_TOKENS = 30_000;
/** Use head+tail+story path when log exceeds this char length (guards against token underestimation; avoids sending ~183k chars). */
const LOG_RAW_THRESHOLD_CHARS = 100_000;
/** When output.log is summarized, keep this many lines from the start and end in full so audit sees init and exit state. */
const OUTPUT_LOG_HEAD_TAIL_LINES = 400;

/** When trimming, per-section caps are scaled from defaults by (budget / DEFAULT_PILL_CONTEXT_BUDGET_TOKENS). Order: outputLog, promptsDigest, sourceFiles, docs, tree. */
const OUTPUT_LOG_MAX_TOKENS_DEFAULT = 14_000;
/** Hard cap on output log chars sent to audit (504 avoidance). Overridable via PILL_OUTPUT_LOG_MAX_CHARS. */
const DEFAULT_OUTPUT_LOG_MAX_CHARS = 50_000;
const PROMPTS_DIGEST_MAX_TOKENS_DEFAULT = 8_000;
const SOURCE_MAX_TOKENS_WHEN_TRIMMED_DEFAULT = 10_000;
const DOCS_MAX_TOKENS_WHEN_TRIMMED_DEFAULT = 2_000;
const TREE_MAX_TOKENS_WHEN_TRIMMED_DEFAULT = 1_000;

const AUDIT_TRUNCATE_MARKER =
  '\n\n[ ... truncated for audit request size (504 timeout avoidance) ... ]\n\n';
const OUTPUT_LOG_CAP_MARKER =
  '\n\n[ ... truncated (output log char cap for 504 avoidance) ... ]\n\n';

function formatPromptsRaw(entries: { slug: string; type: string; content: string }[]): string {
  const parts = entries.map((e) => `--- ${e.slug} ${e.type} ---\n${e.content}`);
  return parts.join('\n\n');
}

/**
 * Extract high-signal lines from output.log that are often lost when the log is story-read.
 * These are always appended to context so the audit model sees overlap, model performance, and lesson text.
 */
function extractStructuredOutputLogEvidence(raw: string): string {
  const lines = raw.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (
      line.includes('overlapVerifiedAndDismissed') ||
      line.includes('Overlap IDs (verifiedFixed') ||
      line.includes('RESULTS SUMMARY counts') ||
      line.includes('need to modify one of:')
    ) {
      out.push(line.trim());
    }
    if (line.includes('Model Performance') || line.includes('Token Usage') || line.includes('Timing Summary')) {
      // Include the section header and the next 12 lines (table body)
      out.push(line.trim());
      for (let j = i + 1; j < Math.min(i + 13, lines.length); j++) {
        const next = lines[j];
        if (next.startsWith('[') || next.includes('│') || next.includes('─') || /^\s*\S+.*\d+%/.test(next) || next.trim() === '') {
          out.push(next.trim());
        } else {
          break;
        }
      }
    }
  }
  return out.length ? out.join('\n') : '';
}

function getOutputLogHead(raw: string, lineCount: number): string {
  const lines = raw.split('\n');
  return lines.slice(0, lineCount).join('\n');
}

function getOutputLogTail(raw: string, lineCount: number): string {
  const lines = raw.split('\n');
  return lines.slice(-lineCount).join('\n');
}

function getOutputLogMiddle(raw: string, headLines: number, tailLines: number): string {
  const lines = raw.split('\n');
  if (lines.length <= headLines + tailLines) return '';
  return lines.slice(headLines, lines.length - tailLines).join('\n');
}

/**
 * Assemble context. Pass llmClient so large logs can be story-read.
 */
export async function assembleContext(
  config: PillConfig,
  llmClient?: LLMClientForProcessor
): Promise<PillContext> {
  const targetDir = config.targetDir;

  let docs = readDocFiles(targetDir);
  let sourceFiles = readSourceFiles(targetDir, SOURCE_TOKEN_BUDGET);
  let directoryTree = readDirectoryTree(targetDir);

  const prefix = config.logPrefix;
  const outputLogName = prefix ? `${prefix}-output.log` : 'output.log';
  const promptsLogName = prefix ? `${prefix}-prompts.log` : 'prompts.log';
  const outputLogPath = join(targetDir, outputLogName);

  let outputLog = '';
  if (existsSync(outputLogPath)) {
    try {
      const raw = readFileSync(outputLogPath, 'utf-8');
      const tokens = estimateTokens(raw);
      // WHY two conditions: Char threshold guards against token underestimation; avoids sending ~183k chars (504).
      const useChunked =
        tokens > LOG_RAW_THRESHOLD_TOKENS || raw.length > LOG_RAW_THRESHOLD_CHARS;
      if (!useChunked) {
        outputLog = raw;
      } else if (llmClient) {
        const head = getOutputLogHead(raw, OUTPUT_LOG_HEAD_TAIL_LINES);
        const tail = getOutputLogTail(raw, OUTPUT_LOG_HEAD_TAIL_LINES);
        const middle = getOutputLogMiddle(raw, OUTPUT_LOG_HEAD_TAIL_LINES, OUTPUT_LOG_HEAD_TAIL_LINES);
        const excerpt = extractStructuredOutputLogEvidence(raw);
        const summaryMiddle = middle
          ? await storyReadPlainText(middle, llmClient, { model: config.llmModel })
          : '';
        const middleBlock = summaryMiddle
          ? ['', '[ ... middle section summarized ... ]', summaryMiddle].join('\n')
          : '';
        outputLog = [head, middleBlock, '', '[ ... end of log ... ]', tail, excerpt ? '\n[EXTRACTED EVIDENCE FOR AUDIT]\n' + excerpt : '']
          .filter(Boolean)
          .join('\n');
      } else {
        // WHY: No client (e.g. dry-run or no API key); sending raw would still cause 504. Use head+tail only.
        const head = getOutputLogHead(raw, OUTPUT_LOG_HEAD_TAIL_LINES);
        const tail = getOutputLogTail(raw, OUTPUT_LOG_HEAD_TAIL_LINES);
        const excerpt = extractStructuredOutputLogEvidence(raw);
        outputLog = [head, '', '[ ... middle omitted (no summarization client) ... ]', '', tail, excerpt ? '\n[EXTRACTED EVIDENCE FOR AUDIT]\n' + excerpt : '']
          .filter(Boolean)
          .join('\n');
      }
    } catch { /* missing or unreadable */ }
  }

  let promptsDigest: string | undefined;
  const promptsPath = join(targetDir, promptsLogName);
  if (existsSync(promptsPath)) {
    let rawPrompts: string;
    try {
      rawPrompts = readFileSync(promptsPath, 'utf-8');
    } catch {
      rawPrompts = '';
    }
    if (rawPrompts) {
      const entries = parsePromptsLog(rawPrompts);
      const promptsTokens = estimateTokens(rawPrompts);
      if (promptsTokens <= LOG_RAW_THRESHOLD_TOKENS) {
        promptsDigest = formatPromptsRaw(entries);
      } else if (llmClient) {
        promptsDigest = await processLogChapters(entries, llmClient, { model: config.llmModel });
      } else {
        promptsDigest = formatPromptsRaw(entries);
      }
    }
  }

  // Pill-on-itself: if primary logs are not pill's own, also include pill-output.log when present.
  const pillOutputName = 'pill-output.log';
  const pillPromptsName = 'pill-prompts.log';
  if (outputLogName !== pillOutputName) {
    const pillOutputPath = join(targetDir, pillOutputName);
    if (existsSync(pillOutputPath)) {
      try {
        const pillRaw = readFileSync(pillOutputPath, 'utf-8');
        if (pillRaw.trim()) {
          outputLog += '\n\n[PILL SELF-LOG]\n' + pillRaw;
        }
      } catch { /* ignore */ }
    }
    const pillPromptsPath = join(targetDir, pillPromptsName);
    if (existsSync(pillPromptsPath) && (!promptsDigest || promptsPath !== pillPromptsPath)) {
      try {
        const pillPromptsRaw = readFileSync(pillPromptsPath, 'utf-8');
        if (pillPromptsRaw.trim()) {
          const entries = parsePromptsLog(pillPromptsRaw);
          const formatted = formatPromptsRaw(entries);
          promptsDigest = (promptsDigest ?? '') + (promptsDigest ? '\n\n[PILL SELF PROMPTS]\n' : '') + formatted;
        }
      } catch { /* ignore */ }
    }
  }

  // WHY hard char cap: Ensures audit request never includes unbounded log; 504 is often size/time related.
  const maxOutputLogChars = (() => {
    const env = process.env.PILL_OUTPUT_LOG_MAX_CHARS?.trim();
    if (env !== undefined && env !== '') {
      const n = parseInt(env, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return DEFAULT_OUTPUT_LOG_MAX_CHARS;
  })();
  if (outputLog.length > maxOutputLogChars) {
    outputLog = truncateHeadAndTailByChars(outputLog, maxOutputLogChars, OUTPUT_LOG_CAP_MARKER);
  }

  const auditBudgetTokens = config.contextBudgetTokens ?? DEFAULT_PILL_CONTEXT_BUDGET_TOKENS;
  const scale = auditBudgetTokens / DEFAULT_PILL_CONTEXT_BUDGET_TOKENS;
  const OUTPUT_LOG_MAX_TOKENS = Math.max(2_000, Math.round(OUTPUT_LOG_MAX_TOKENS_DEFAULT * scale));
  const PROMPTS_DIGEST_MAX_TOKENS = Math.max(1_000, Math.round(PROMPTS_DIGEST_MAX_TOKENS_DEFAULT * scale));
  const SOURCE_MAX_TOKENS_WHEN_TRIMMED = Math.max(1_000, Math.round(SOURCE_MAX_TOKENS_WHEN_TRIMMED_DEFAULT * scale));
  const DOCS_MAX_TOKENS_WHEN_TRIMMED = Math.max(500, Math.round(DOCS_MAX_TOKENS_WHEN_TRIMMED_DEFAULT * scale));
  const TREE_MAX_TOKENS_WHEN_TRIMMED = Math.max(200, Math.round(TREE_MAX_TOKENS_WHEN_TRIMMED_DEFAULT * scale));

  let contextTrimmed = false;
  let totalTokens =
    estimateTokens(docs) +
    estimateTokens(sourceFiles) +
    estimateTokens(directoryTree) +
    estimateTokens(outputLog) +
    (promptsDigest ? estimateTokens(promptsDigest) : 0);

  // WHY trim order: outputLog and promptsDigest are largest; trim them first so we stay under budget (504 avoidance).
  if (totalTokens > auditBudgetTokens) {
    contextTrimmed = true;
    if (estimateTokens(outputLog) > OUTPUT_LOG_MAX_TOKENS) {
      outputLog = truncateHeadAndTail(outputLog, OUTPUT_LOG_MAX_TOKENS, AUDIT_TRUNCATE_MARKER);
    }
    totalTokens =
      estimateTokens(docs) +
      estimateTokens(sourceFiles) +
      estimateTokens(directoryTree) +
      estimateTokens(outputLog) +
      (promptsDigest ? estimateTokens(promptsDigest) : 0);
    if (totalTokens > auditBudgetTokens && promptsDigest && estimateTokens(promptsDigest) > PROMPTS_DIGEST_MAX_TOKENS) {
      promptsDigest = truncateHeadAndTail(promptsDigest, PROMPTS_DIGEST_MAX_TOKENS, AUDIT_TRUNCATE_MARKER);
    }
    totalTokens =
      estimateTokens(docs) +
      estimateTokens(sourceFiles) +
      estimateTokens(directoryTree) +
      estimateTokens(outputLog) +
      (promptsDigest ? estimateTokens(promptsDigest) : 0);
    if (totalTokens > auditBudgetTokens && estimateTokens(sourceFiles) > SOURCE_MAX_TOKENS_WHEN_TRIMMED) {
      sourceFiles = truncateHeadAndTail(sourceFiles, SOURCE_MAX_TOKENS_WHEN_TRIMMED, AUDIT_TRUNCATE_MARKER);
    }
    totalTokens =
      estimateTokens(docs) +
      estimateTokens(sourceFiles) +
      estimateTokens(directoryTree) +
      estimateTokens(outputLog) +
      (promptsDigest ? estimateTokens(promptsDigest) : 0);
    if (totalTokens > auditBudgetTokens && estimateTokens(directoryTree) > TREE_MAX_TOKENS_WHEN_TRIMMED) {
      directoryTree = truncateHeadAndTail(directoryTree, TREE_MAX_TOKENS_WHEN_TRIMMED, AUDIT_TRUNCATE_MARKER);
    }
    totalTokens =
      estimateTokens(docs) +
      estimateTokens(sourceFiles) +
      estimateTokens(directoryTree) +
      estimateTokens(outputLog) +
      (promptsDigest ? estimateTokens(promptsDigest) : 0);
    if (totalTokens > auditBudgetTokens && estimateTokens(docs) > DOCS_MAX_TOKENS_WHEN_TRIMMED) {
      docs = truncateHeadAndTail(docs, DOCS_MAX_TOKENS_WHEN_TRIMMED, AUDIT_TRUNCATE_MARKER);
    }
  }

  return {
    docs,
    sourceFiles,
    directoryTree,
    outputLog,
    promptsDigest,
    ...(contextTrimmed ? { contextTrimmed: true } : {}),
  };
}

/** Return token counts per section for verbose output. */
export function getContextTokenCounts(ctx: PillContext): Record<string, number> {
  return {
    docs: estimateTokens(ctx.docs),
    sourceFiles: estimateTokens(ctx.sourceFiles),
    directoryTree: estimateTokens(ctx.directoryTree),
    outputLog: estimateTokens(ctx.outputLog),
    promptsDigest: ctx.promptsDigest ? estimateTokens(ctx.promptsDigest) : 0,
  };
}
