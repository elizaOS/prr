/**
 * LLM-based prediction of likely new bot feedback on the diff we're about to push.
 * Conditioned on existing PR comments and risk map; display only, never blocks push.
 */
import type { ReviewComment } from '../github/types.js';
import type { LLMClient } from '../llm/client.js';
import { summarizeBotRiskByFile } from './bot-risk.js';
import { debug, warn } from '../logger.js';

/** Single predicted concern (file, optional line, one-line concern). */
export interface PredictedFeedback {
  path: string;
  line?: number;
  concern: string;
}

const MAX_DIFF_LINES = 300;
const MAX_COMMENT_BODY_CHARS = 200;
const MAX_PER_BOT_CHARS = 500;
const MAX_PROMPT_BODY_CHARS = 20_000; // ~5k tokens; leave headroom for system + response

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + '...';
}

function buildCommentsSummary(comments: ReviewComment[]): string {
  const byAuthor = new Map<string, string[]>();
  for (const c of comments) {
    const author = c.author || 'unknown';
    if (!byAuthor.has(author)) byAuthor.set(author, []);
    const bodies = byAuthor.get(author)!;
    if (bodies.length < 2) {
      bodies.push(truncate((c.body || '').replace(/\s+/g, ' ').trim(), MAX_COMMENT_BODY_CHARS));
    }
  }
  const parts: string[] = [];
  for (const [author, bodies] of byAuthor) {
    const text = bodies.join(' | ');
    parts.push(`${author}: ${truncate(text, MAX_PER_BOT_CHARS)}`);
  }
  return parts.length ? parts.join('\n') : 'No existing comments.';
}

function buildRiskMapSummary(riskMap: Map<string, { byBot: Record<string, number>; total: number }>): string {
  const entries = [...riskMap.entries()]
    .filter(([, v]) => v.total >= 2)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 10)
    .map(([path, v]) => `${path} (${v.total})`);
  return entries.length ? entries.join(', ') : 'None.';
}

function truncateDiff(diff: string, maxLines: number): string {
  const lines = diff.split('\n');
  if (lines.length <= maxLines) return diff;
  return lines.slice(0, maxLines).join('\n') + '\n... (diff truncated)';
}

/** Path prefix for tool-managed state; bots should not suggest changes here. */
const PRR_DIR = '.prr/';

/**
 * Strip .prr/ file hunks from a git diff so the bot-prediction LLM doesn't suggest
 * feedback on tool state (e.g. "add .prr/ to .gitignore"). Also used to filter predictions.
 */
function stripPrrFromDiff(diff: string): string {
  const lines = diff.split('\n');
  const out: string[] = [];
  let inPrrHunk = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const pathMatch = line.match(/^diff --git a\/(.+?) b\//);
      const path = pathMatch?.[1]?.replace(/\\/g, '/') ?? '';
      inPrrHunk = path.startsWith(PRR_DIR);
      if (!inPrrHunk) out.push(line);
      continue;
    }
    if (!inPrrHunk) out.push(line);
  }
  return out.join('\n');
}

function isPrrPath(path: string): boolean {
  return path.replace(/\\/g, '/').startsWith(PRR_DIR);
}

/**
 * Parse line-based output: FILE: path, LINE: N, CONCERN: text.
 * Tolerates minor variations; returns [] on parse failure.
 */
function parsePredictedFeedback(content: string): PredictedFeedback[] {
  const result: PredictedFeedback[] = [];
  const lines = content.split('\n').map((l) => l.trim());
  let current: Partial<PredictedFeedback> = {};
  for (const line of lines) {
    if (line.startsWith('FILE:') || line.match(/^FILE\s*:/i)) {
      if (current.path !== undefined && current.concern !== undefined) {
        result.push({ path: current.path, line: current.line, concern: current.concern });
      }
      current = { path: line.replace(/^FILE\s*:\s*/i, '').trim() };
    } else if (line.startsWith('LINE:') || line.match(/^LINE\s*:/i)) {
      const num = parseInt(line.replace(/^LINE\s*:\s*/i, '').trim(), 10);
      current.line = Number.isNaN(num) ? undefined : num;
    } else if (line.startsWith('CONCERN:') || line.match(/^CONCERN\s*:/i)) {
      current.concern = line.replace(/^CONCERN\s*:\s*/i, '').trim();
    }
  }
  if (current.path !== undefined && current.concern !== undefined) {
    result.push({ path: current.path, line: current.line, concern: current.concern });
  }
  return result;
}

export interface PredictBotFeedbackOptions {
  diff: string;
  comments: ReviewComment[];
  changedFiles: string[];
  prTitle: string;
  prBodyOneLine: string;
}

/**
 * Predict likely new bot feedback on the given diff, conditioned on existing comments.
 * Prompt is capped (~6k tokens) to avoid overflow and cost. On failure or parse error, returns [].
 */
export async function predictBotFeedback(
  options: PredictBotFeedbackOptions,
  llm: LLMClient
): Promise<PredictedFeedback[]> {
  const { diff, comments, changedFiles, prTitle, prBodyOneLine } = options;
  const commentsSummary = buildCommentsSummary(comments);
  const riskMap = summarizeBotRiskByFile(comments, changedFiles);
  const riskMapSummary = buildRiskMapSummary(riskMap);
  const diffWithoutPrr = stripPrrFromDiff(diff);
  const truncatedDiff = truncateDiff(diffWithoutPrr, MAX_DIFF_LINES);

  const systemPrompt = `You are simulating what PR review bots (e.g. CodeRabbit, Cursor, Greptile) might comment when they see a new diff. Your task: list 3–7 likely *additional* issues they might raise on this diff, consistent with the style and severity of existing comments on this PR. Output only the list, one issue per block, in this exact format:

FILE: <path>
LINE: <number or leave blank>
CONCERN: <one-line concern>

Be concise. Do not suggest fixes; only list likely concerns.`;

  const body = [
    'Existing review comments on this PR (per bot, 1–2 examples):',
    commentsSummary,
    '',
    'Files with most bot comments so far:',
    riskMapSummary,
    '',
    'PR title:',
    truncate(prTitle, 200),
    '',
    'PR description (first line):',
    truncate(prBodyOneLine, 300),
    '',
    'Diff to be pushed:',
    '---',
    truncatedDiff,
  ].join('\n');

  const prompt = truncate(body, MAX_PROMPT_BODY_CHARS);
  try {
    const response = await llm.complete(prompt, systemPrompt);
    const text = (response?.content ?? '').trim();
    if (!text) return [];
    const parsed = parsePredictedFeedback(text).filter(p => !isPrrPath(p.path));
    return parsed.length > 7 ? parsed.slice(0, 7) : parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warn(`Bot prediction LLM call failed; continuing without prediction. ${msg}`);
    debug('predictBotFeedback error', err);
    return [];
  }
}
