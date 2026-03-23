/**
 * Story-read large logs: chapter-by-chapter analysis with a cheap model.
 * Two entry points:
 *   processLogChapters() — for structured prompts.log (LogEntry[])
 *   storyReadPlainText() — for plain text (output.log or anything else)
 * Do NOT split PROMPT/RESPONSE pairs across chunks.
 *
 * Chunking and story-read loop live in shared/llm/story-read.ts; this module
 * wires pill's log formats (plain text, prompts.log pairs) to that shared core.
 */
import type { LogEntry } from './parser.js';
import {
  storyReadChapters,
  storyReadPlainText as sharedStoryReadPlainText,
  type StoryReadClient,
} from '../../../shared/llm/story-read.js';
import { estimateTokens } from '../utils/files.js';
import { truncateHeadAndTailByChars } from '../../../shared/utils/tokens.js';

/**
 * Max chars per PROMPT/RESPONSE pair before story-read. WHY: A single pair (e.g. 200k-char conflict prompt)
 * used to bypass CHAPTER_TOKEN_BUDGET — one "chapter" was entire blob → gateway timeouts during assembly.
 */
const MAX_PAIR_BODY_CHARS = 18_000;
const PAIR_TRUNCATE_MARKER =
  '\n\n[ ... pill: truncated this prompt/response body for digest size (504 avoidance) ... ]\n\n';

/** Token budget per story-read chapter (pair groups + plain-text chunking). Lower = smaller ElizaCloud requests. */
const CHAPTER_TOKEN_BUDGET = 8_000;

/** Minimal LLM client for chapter analysis (same client as audit, passed in). */
export type LLMClientForProcessor = StoryReadClient;

/** Chunk pairs into chapters under token budget. */
function chunkPairs(pairs: { slug: string; text: string }[]): { slugRange: string; text: string }[] {
  const chapters: { slugRange: string; text: string }[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  let startSlug = pairs[0]?.slug ?? '';
  let endSlug = startSlug;

  for (const { slug, text } of pairs) {
    const bounded =
      text.length > MAX_PAIR_BODY_CHARS
        ? truncateHeadAndTailByChars(text, MAX_PAIR_BODY_CHARS, PAIR_TRUNCATE_MARKER)
        : text;
    const tokens = estimateTokens(bounded);
    if (currentTokens + tokens > CHAPTER_TOKEN_BUDGET && current.length > 0) {
      chapters.push({
        slugRange: `${startSlug}–${endSlug}`,
        text: current.join('\n\n'),
      });
      current = [];
      currentTokens = 0;
      startSlug = slug;
    }
    current.push(bounded);
    currentTokens += tokens;
    endSlug = slug;
  }
  if (current.length > 0) {
    chapters.push({ slugRange: `${startSlug}–${endSlug}`, text: current.join('\n\n') });
  }
  return chapters;
}

/** Pair PROMPT + RESPONSE (and optional ERROR) per slug. ERROR entries are included so pill digest shows failed requests. */
function groupPairs(entries: LogEntry[]): { slug: string; text: string }[] {
  const pairs: { slug: string; text: string }[] = [];
  const bySlug = new Map<string, { prompt?: LogEntry; response?: LogEntry; error?: LogEntry }>();
  for (const e of entries) {
    let pair = bySlug.get(e.slug);
    if (!pair) {
      pair = {};
      bySlug.set(e.slug, pair);
    }
    if (e.type === 'PROMPT') pair.prompt = e;
    else if (e.type === 'RESPONSE') pair.response = e;
    else if (e.type === 'ERROR') pair.error = e;
  }
  const sortedSlugs = [...bySlug.keys()].sort((a, b) => {
    const aId = parseInt(a.replace(/^#(\d+).*/, '$1'), 10);
    const bId = parseInt(b.replace(/^#(\d+).*/, '$1'), 10);
    return aId - bId;
  });
  for (const slug of sortedSlugs) {
    const pair = bySlug.get(slug)!;
    const parts: string[] = [];
    if (pair.prompt) {
      parts.push(`--- ${slug} PROMPT ---\n${pair.prompt.content}`);
    }
    if (pair.response) {
      parts.push(`--- ${slug} RESPONSE ---\n${pair.response.content}`);
    }
    if (pair.error) {
      parts.push(`--- ${slug} ERROR ---\n${pair.error.content}`);
    }
    if (parts.length) {
      pairs.push({ slug, text: parts.join('\n\n') });
    }
  }
  return pairs;
}

/**
 * Story-read arbitrary plain text (e.g. output.log).
 * Chunks by line boundaries, runs each through the cheap model, compiles a digest.
 */
/** Plain-text logs (e.g. output.log middle): slightly larger chapters than paired prompts — still bounded for ElizaCloud. */
const PLAIN_TEXT_CHAPTER_TOKEN_BUDGET = 10_000;

export async function storyReadPlainText(
  text: string,
  client: LLMClientForProcessor,
  options: { model?: string } = {}
): Promise<string> {
  return sharedStoryReadPlainText(text, client, {
    ...options,
    chapterTokenBudget: PLAIN_TEXT_CHAPTER_TOKEN_BUDGET,
  });
}

/**
 * Process a large list of log entries into a digest via story-reading.
 * Uses the same LLM client as the audit step.
 */
export async function processLogChapters(
  entries: LogEntry[],
  client: LLMClientForProcessor,
  options: { model?: string } = {}
): Promise<string> {
  const pairs = groupPairs(entries);
  if (pairs.length === 0) return '';
  const chapters = chunkPairs(pairs);
  return storyReadChapters(chapters, client, options);
}
