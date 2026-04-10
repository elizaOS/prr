/**
 * Story-read: chapter-by-chapter LLM summarization with carried context.
 *
 * Long text is split into chapters (by token budget). Each chapter is sent to the
 * model with compressed context from previous chapters (open questions, predictions,
 * story threads). The model returns structured analysis (observations, new
 * questions, refuted predictions, etc.); we merge state and pass it forward.
 * Final output is a digest (observations, unanswered questions, refuted predictions,
 * threads).
 *
 * Used by pill for output.log and prompts.log summarization; can be reused by any
 * tool that needs to summarize large logs or documents without losing narrative.
 */
import { estimateTokens } from '../utils/tokens.js';

const DEFAULT_CHAPTER_TOKEN_BUDGET = 35_000;
const DEFAULT_MAX_CONTEXT_TOKENS = 5_000;

/** Per-chapter analysis schema returned by the model. */
export interface ChapterAnalysis {
  observations: string[];
  answeredQuestions: string[];
  confirmedPredictions: string[];
  refutedPredictions: string[];
  newQuestions: string[];
  newPredictions: string[];
  threads: string[];
}

/** Minimal client for story-read (same shape as pill's LLMClientForProcessor). */
export interface StoryReadClient {
  complete(
    userPrompt: string,
    systemPrompt: string,
    options?: { model?: string }
  ): Promise<{ content: string }>;
}

export interface StoryReadOptions {
  model?: string;
  /** System prompt for each chapter; defaults to log-analysis prompt. */
  systemPrompt?: string;
  /** Token budget per chapter when chunking plain text. */
  chapterTokenBudget?: number;
  /** Max tokens for "prior context" passed into each chapter. */
  maxContextTokens?: number;
  /** On chapter LLM failure: 'break' (stop, return digest so far), 'skip' (continue), 'throw'. */
  onChapterError?: 'break' | 'skip' | 'throw';
}

const DEFAULT_SYSTEM_PROMPT = `You are reading a log from a software tool run, chapter by chapter.
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

/**
 * Split plain text into line-boundary chunks under the token budget.
 * WHY line boundaries: Logs and docs are line-oriented; splitting mid-line would send broken context to the model.
 */
export function chunkPlainText(
  text: string,
  chapterTokenBudget: number = DEFAULT_CHAPTER_TOKEN_BUDGET
): { label: string; text: string }[] {
  const lines = text.split('\n');
  const chapters: { label: string; text: string }[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  let startLine = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineTokens = estimateTokens(line);
    // WHY: Single line over budget (e.g. minified blob) would become one oversized chapter; emit as own chapter.
    if (lineTokens > chapterTokenBudget && current.length === 0) {
      chapters.push({
        label: `lines ${i + 1}–${i + 1}`,
        text: line,
      });
      startLine = i + 2;
      continue;
    }
    if (currentTokens + lineTokens > chapterTokenBudget && current.length > 0) {
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

function buildChapterPrompt(chapter: { slugRange: string; text: string }, priorContext: string): string {
  const contextSection = priorContext
    ? `CONTEXT FROM PREVIOUS CHAPTERS:\n${priorContext}\n\n`
    : '';
  return `${contextSection}THIS CHAPTER (${chapter.slugRange}):\n\n${chapter.text}`;
}

/** WHY: Keep prior context small so each chapter prompt stays under model limits; slice(-20) etc. keeps recent items. */
function compressContext(
  openQuestions: string[],
  predictions: string[],
  threads: string[],
  maxContextTokens: number
): string {
  const parts: string[] = [];
  if (openQuestions.length) {
    parts.push('Open questions: ' + openQuestions.slice(-20).join('; '));
  }
  if (predictions.length) {
    parts.push('Active predictions: ' + predictions.slice(-15).join('; '));
  }
  const threadText = threads.join(' ');
  const threadTokens = estimateTokens(threadText);
  if (threadTokens > maxContextTokens) {
    parts.push('Story so far: [compressed] ' + threadText.slice(0, maxContextTokens * 4));
  } else if (threads.length) {
    parts.push('Story so far: ' + threadText);
  }
  return parts.join('\n');
}

/** WHY strip markdown fences: Models sometimes wrap JSON in ```json ... ```; we extract the first {...} for robustness. */
export function parseChapterAnalysis(raw: string): ChapterAnalysis {
  const stripped = raw
    .replace(/^\s*```\w*\n?/g, '')
    .replace(/\n?```\s*$/g, '')
    .trim();
  const firstBrace = stripped.indexOf('{');
  if (firstBrace === -1) {
    return emptyChapterAnalysis();
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
    return emptyChapterAnalysis();
  }
}

function emptyChapterAnalysis(): ChapterAnalysis {
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

/**
 * Run the story-read loop over pre-chunked chapters and return a digest.
 */
export async function storyReadChapters(
  chapters: { slugRange: string; text: string }[],
  client: StoryReadClient,
  options: StoryReadOptions = {}
): Promise<string> {
  const systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const maxContextTokens = options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
  const onError = options.onChapterError ?? 'break';

  const analyses: ChapterAnalysis[] = [];
  let openQuestions: string[] = [];
  let predictions: string[] = [];
  let threads: string[] = [];

  for (let i = 0; i < chapters.length; i++) {
    const priorContext = compressContext(openQuestions, predictions, threads, maxContextTokens);
    const userPrompt = buildChapterPrompt(chapters[i], priorContext);
    let analysis: ChapterAnalysis;
    try {
      const res = await client.complete(userPrompt, systemPrompt, { model: options.model });
      analysis = parseChapterAnalysis(res.content);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (onError === 'throw') throw err;
      if (onError === 'break') {
        console.warn(
          `Warning: story-read chapter ${i + 1}/${chapters.length} failed: ${msg}`
        );
        break;
      }
      // skip: use empty analysis and continue
      analysis = emptyChapterAnalysis();
    }
    analyses.push(analysis);

    const answeredSet = new Set(analysis.answeredQuestions.map((a) => a.toLowerCase()));
    const confirmedSet = new Set(analysis.confirmedPredictions.map((c) => c.toLowerCase()));
    const refutedSet = new Set(analysis.refutedPredictions.map((r) => r.toLowerCase()));
    openQuestions = openQuestions.filter(
      (q) =>
        !answeredSet.has(q.toLowerCase()) &&
        !analysis.answeredQuestions.some((a) => a.includes(q))
    );
    openQuestions.push(...analysis.newQuestions);
    predictions = predictions.filter(
      (p) =>
        !confirmedSet.has(p.toLowerCase()) &&
        !refutedSet.has(p.toLowerCase()) &&
        !analysis.confirmedPredictions.some((c) => c.includes(p)) &&
        !analysis.refutedPredictions.some((r) => r.includes(p))
    );
    predictions.push(...analysis.newPredictions);
    threads = [...threads, ...analysis.threads];
  }

  const observations = new Set<string>();
  for (const a of analyses) {
    a.observations.forEach((o) => observations.add(o));
  }
  const refuted = analyses.flatMap((a) => a.refutedPredictions);
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
 * Story-read plain text: chunk by lines, then run story-read and return digest.
 * If text fits in one chapter, returns the original text (no LLM call).
 * WHY no LLM when single chapter: Small text doesn't need summarization; avoid cost and latency.
 */
export async function storyReadPlainText(
  text: string,
  client: StoryReadClient,
  options: StoryReadOptions = {}
): Promise<string> {
  const budget = options.chapterTokenBudget ?? DEFAULT_CHAPTER_TOKEN_BUDGET;
  const chapters = chunkPlainText(text, budget);
  if (chapters.length === 0) return '';
  if (chapters.length === 1) return text;

  return storyReadChapters(
    chapters.map((c) => ({ slugRange: c.label, text: c.text })),
    client,
    options
  );
}
