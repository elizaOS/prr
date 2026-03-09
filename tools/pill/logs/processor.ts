/**
 * Story-read large logs: chapter-by-chapter analysis with a cheap model.
 * Two entry points:
 *   processLogChapters() — for structured prompts.log (LogEntry[])
 *   storyReadPlainText() — for plain text (output.log or anything else)
 * Do NOT split PROMPT/RESPONSE pairs across chunks.
 */
import type { LogEntry } from './parser.js';
import type { ChapterAnalysis } from '../types.js';
import { estimateTokens } from '../utils/files.js';

const CHAPTER_TOKEN_BUDGET = 35_000;
const MAX_CONTEXT_TOKENS = 5_000;

/** Minimal LLM client for chapter analysis (same client as audit, passed in). */
export interface LLMClientForProcessor {
  complete(userPrompt: string, systemPrompt: string, options?: { model?: string }): Promise<{ content: string }>;
}

/** Split plain text into line-boundary chunks under the token budget. */
function chunkPlainText(text: string): { label: string; text: string }[] {
  const lines = text.split('\n');
  const chapters: { label: string; text: string }[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  let startLine = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineTokens = estimateTokens(line);
    if (currentTokens + lineTokens > CHAPTER_TOKEN_BUDGET && current.length > 0) {
      chapters.push({
        label: `lines ${startLine}–${startLine + current.length - 1}`,
        text: current.join('\n'),
      });
      current = [];
      currentTokens = 0;
      startLine = i + 1;
    }
    current.push(line);
    currentTokens += lineTokens;
  }
  if (current.length > 0) {
    chapters.push({
      label: `lines ${startLine}–${startLine + current.length - 1}`,
      text: current.join('\n'),
    });
  }
  return chapters;
}

/**
 * Story-read arbitrary plain text (e.g. output.log).
 * Chunks by line boundaries, runs each through the cheap model, compiles a digest.
 */
export async function storyReadPlainText(
  text: string,
  client: LLMClientForProcessor,
  options: { model?: string } = {}
): Promise<string> {
  const chapters = chunkPlainText(text);
  if (chapters.length === 0) return '';
  if (chapters.length === 1) return text;

  return storyReadChapters(
    chapters.map((c) => ({ slugRange: c.label, text: c.text })),
    client,
    options
  );
}

/** Pair PROMPT + RESPONSE with same slug. */
function groupPairs(entries: LogEntry[]): { slug: string; text: string }[] {
  const pairs: { slug: string; text: string }[] = [];
  const bySlug = new Map<string, { prompt?: LogEntry; response?: LogEntry }>();
  for (const e of entries) {
    let pair = bySlug.get(e.slug);
    if (!pair) {
      pair = {};
      bySlug.set(e.slug, pair);
    }
    if (e.type === 'PROMPT') pair.prompt = e;
    else pair.response = e;
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
    if (parts.length) {
      pairs.push({ slug, text: parts.join('\n\n') });
    }
  }
  return pairs;
}

/** Chunk pairs into chapters under token budget. */
function chunkPairs(pairs: { slug: string; text: string }[]): { slugRange: string; text: string }[] {
  const chapters: { slugRange: string; text: string }[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  let startSlug = pairs[0]?.slug ?? '';
  let endSlug = startSlug;

  for (const { slug, text } of pairs) {
    const tokens = estimateTokens(text);
    if (currentTokens + tokens > CHAPTER_TOKEN_BUDGET && current.length > 0) {
      chapters.push({
        slugRange: `${startSlug}–${endSlug}`,
        text: current.join('\n\n'),
      });
      current = [];
      currentTokens = 0;
      startSlug = slug;
    }
    current.push(text);
    currentTokens += tokens;
    endSlug = slug;
  }
  if (current.length > 0) {
    chapters.push({ slugRange: `${startSlug}–${endSlug}`, text: current.join('\n\n') });
  }
  return chapters;
}

const CHAPTER_SYSTEM = `You are reading a log from a software tool run, chapter by chapter.
You are building understanding progressively -- like debugging.

Analyze each chapter and return JSON only (no markdown fences, no explanation):
{
  "observations": ["immediate findings, anomalies, errors, patterns"],
  "answeredQuestions": ["which open questions this chapter answers, with the answer"],
  "confirmedPredictions": ["which predictions came true"],
  "refutedPredictions": ["which predictions were WRONG and why -- these are important"],
  "newQuestions": ["new questions raised by this chapter"],
  "newPredictions": ["what you expect to happen next based on what you've seen"],
  "threads": ["update to ongoing story threads"]
}`;

function buildChapterPrompt(chapter: { slugRange: string; text: string }, priorContext: string): string {
  const contextSection = priorContext
    ? `CONTEXT FROM PREVIOUS CHAPTERS:\n${priorContext}\n\n`
    : '';
  return `${contextSection}THIS CHAPTER (${chapter.slugRange}):\n\n${chapter.text}`;
}

function compressContext(openQuestions: string[], predictions: string[], threads: string[]): string {
  const parts: string[] = [];
  if (openQuestions.length) {
    parts.push('Open questions: ' + openQuestions.slice(-20).join('; '));
  }
  if (predictions.length) {
    parts.push('Active predictions: ' + predictions.slice(-15).join('; '));
  }
  const threadText = threads.join(' ');
  const threadTokens = estimateTokens(threadText);
  if (threadTokens > MAX_CONTEXT_TOKENS) {
    parts.push('Story so far: [compressed] ' + threadText.slice(0, MAX_CONTEXT_TOKENS * 4));
  } else if (threads.length) {
    parts.push('Story so far: ' + threadText);
  }
  return parts.join('\n');
}

function parseChapterAnalysis(raw: string): ChapterAnalysis {
  const stripped = raw
    .replace(/^\s*```\w*\n?/g, '')
    .replace(/\n?```\s*$/g, '')
    .trim();
  const firstBrace = stripped.indexOf('{');
  if (firstBrace === -1) {
    return {
      observations: [],
      answeredQuestions: [],
      confirmedPredictions: [],
      refutedPredictions: [],
      newQuestions: [],
      newPredictions: [],
      threads: [],
    };
  }
  let depth = 0;
  let end = firstBrace;
  for (let i = firstBrace; i < stripped.length; i++) {
    if (stripped[i] === '{') depth++;
    if (stripped[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  const jsonStr = stripped.slice(firstBrace, end);
  try {
    const o = JSON.parse(jsonStr) as Record<string, unknown>;
    const arr = (key: string) => (Array.isArray(o[key]) ? (o[key] as string[]) : []);
    return {
      observations: arr('observations'),
      answeredQuestions: arr('answeredQuestions'),
      confirmedPredictions: arr('confirmedPredictions'),
      refutedPredictions: arr('refutedPredictions'),
      newQuestions: arr('newQuestions'),
      newPredictions: arr('newPredictions'),
      threads: arr('threads'),
    };
  } catch {
    return {
      observations: [],
      answeredQuestions: [],
      confirmedPredictions: [],
      refutedPredictions: [],
      newQuestions: [],
      newPredictions: [],
      threads: [],
    };
  }
}

/** Shared story-reading loop over pre-chunked chapters. */
async function storyReadChapters(
  chapters: { slugRange: string; text: string }[],
  client: LLMClientForProcessor,
  options: { model?: string } = {}
): Promise<string> {
  const analyses: ChapterAnalysis[] = [];
  let openQuestions: string[] = [];
  let predictions: string[] = [];
  let threads: string[] = [];

  for (let i = 0; i < chapters.length; i++) {
    const priorContext = compressContext(openQuestions, predictions, threads);
    const userPrompt = buildChapterPrompt(chapters[i], priorContext);
    let analysis: ChapterAnalysis;
    try {
      const res = await client.complete(userPrompt, CHAPTER_SYSTEM, { model: options.model });
      analysis = parseChapterAnalysis(res.content);
    } catch (err) {
      console.warn(`Warning: chapter ${i + 1}/${chapters.length} LLM call failed: ${err instanceof Error ? err.message : err}`);
      break;
    }
    analyses.push(analysis);

    const answeredSet = new Set(analysis.answeredQuestions.map((a: string) => a.toLowerCase()));
    const confirmedSet = new Set(analysis.confirmedPredictions.map((c: string) => c.toLowerCase()));
    const refutedSet = new Set(analysis.refutedPredictions.map((r: string) => r.toLowerCase()));
    openQuestions = openQuestions.filter(
      (q) => !answeredSet.has(q.toLowerCase()) && !analysis.answeredQuestions.some((a: string) => a.includes(q))
    );
    openQuestions.push(...analysis.newQuestions);
    predictions = predictions.filter(
      (p) =>
        !confirmedSet.has(p.toLowerCase()) &&
        !refutedSet.has(p.toLowerCase()) &&
        !analysis.confirmedPredictions.some((c: string) => c.includes(p)) &&
        !analysis.refutedPredictions.some((r: string) => r.includes(p))
    );
    predictions.push(...analysis.newPredictions);
    threads = [...threads, ...analysis.threads];
  }

  const observations = new Set<string>();
  for (const a of analyses) {
    a.observations.forEach((o: string) => observations.add(o));
  }
  const refuted = analyses.flatMap((a: ChapterAnalysis) => a.refutedPredictions);
  const patterns: string[] = [];
  if (refuted.length) {
    patterns.push('Refuted predictions (high signal): ' + refuted.join('; '));
  }
  if (observations.size) {
    patterns.push('Key observations: ' + [...observations].slice(0, 30).join('; '));
  }

  const digestParts: string[] = [
    '## Key observations',
    [...observations].slice(0, 50).join('\n'),
    '',
    '## Unanswered questions',
    openQuestions.length ? openQuestions.join('\n') : '(none)',
    '',
    '## Refuted predictions (high-value signals)',
    refuted.length ? refuted.join('\n') : '(none)',
    '',
    '## Thread arcs',
    threads.length ? threads.join('\n') : '(none)',
    '',
    '## Patterns',
    patterns.join('\n'),
  ];
  return digestParts.join('\n');
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
