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

  let outputLog = '';
  const outputLogPath = join(targetDir, 'output.log');
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
  const promptsPath = join(targetDir, 'prompts.log');
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
