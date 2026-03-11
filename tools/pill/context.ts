/**
 * Assemble full PillContext: docs + source + output.log + prompts digest.
 * Both logs are included in full when small (< 40k tokens) and story-read when large.
 */
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import type { PillConfig, PillContext } from './types.js';
import {
  readDocFiles,
  readSourceFiles,
  readDirectoryTree,
  estimateTokens,
} from './utils/files.js';
import { parsePromptsLog } from './logs/parser.js';
import { processLogChapters, storyReadPlainText, type LLMClientForProcessor } from './logs/processor.js';

const SOURCE_TOKEN_BUDGET = 80_000;
const LOG_RAW_THRESHOLD_TOKENS = 40_000;

function formatPromptsRaw(entries: { slug: string; type: string; content: string }[]): string {
  const parts = entries.map((e) => `--- ${e.slug} ${e.type} ---\n${e.content}`);
  return parts.join('\n\n');
}

/**
 * Assemble context. Pass llmClient so large logs can be story-read.
 */
export async function assembleContext(
  config: PillConfig,
  llmClient?: LLMClientForProcessor
): Promise<PillContext> {
  const targetDir = config.targetDir;

  const docs = readDocFiles(targetDir);
  const sourceFiles = readSourceFiles(targetDir, SOURCE_TOKEN_BUDGET);
  const directoryTree = readDirectoryTree(targetDir);

  const prefix = config.logPrefix;
  const outputLogName = prefix ? `${prefix}-output.log` : 'output.log';
  const promptsLogName = prefix ? `${prefix}-prompts.log` : 'prompts.log';
  const outputLogPath = join(targetDir, outputLogName);

  let outputLog = '';
  if (existsSync(outputLogPath)) {
    try {
      const raw = readFileSync(outputLogPath, 'utf-8');
      const tokens = estimateTokens(raw);
      if (tokens <= LOG_RAW_THRESHOLD_TOKENS) {
        outputLog = raw;
      } else if (llmClient) {
        outputLog = await storyReadPlainText(raw, llmClient, { model: config.llmModel });
      } else {
        outputLog = raw;
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

  return {
    docs,
    sourceFiles,
    directoryTree,
    outputLog,
    promptsDigest,
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
