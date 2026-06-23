/**
 * Shared prompt / code context budgeting: one place to derive how many characters of
 * file content fit for a model, and line-centered fitting when content exceeds the budget.
 *
 * WHY centralize: Output.log audits showed different code paths each had their own “max snippet
 * chars” or line counts. They drifted — one path sent 80k+ to a 32k-window model (opaque 500s),
 * another trimmed so aggressively the review line never appeared (false STALE / wrong YES).
 * **`computeBudget`** ties the cap to **`getMaxElizacloudLlmCompleteInputChars`** / fix-prompt
 * ceilings so changing defaults or models updates every consumer. **`reservedChars`** is the
 * caller’s estimate of non-file text (instructions, comment bodies, diff wrappers); **`divisor`**
 * splits the remainder across N injected slots (e.g. N fixes in one verify batch).
 *
 * WHY **`fitToBudget`**: When the whole file does not fit, we prefer a **line-centered** excerpt
 * on the GitHub review line or a **keyword anchor** from the comment body — not only “first N
 * lines”, which hid tail bugs and drove false final-audit UNFIXED (see DEVELOPMENT.md).
 *
 * Consumers: **`issue-analysis-snippet-helpers`**, **`issue-analysis-snippets`**, **`LLMClient`**
 * batch verify, **`fix-verification`** (`getCurrentCodeAtLine`). Tests: **`tests/prompt-budget.test.ts`**.
 */
import { formatNumber } from './logger.js';
import {
  ELIZACLOUD_LLM_COMPLETE_INPUT_OVERHEAD_CHARS,
  getMaxElizacloudLlmCompleteInputChars,
  getMaxFixPromptCharsForModel,
} from './llm/model-context-limits.js';

/** Hard rail: never treat more than this as "full file" for budgeting (pathological files). */
export const PROMPT_BUDGET_MAX_FULL_FILE_CHARS = 500_000;

export function inputCeilingCharsForModel(model: string | undefined): number {
  const m = model?.trim();
  if (!m) return getMaxElizacloudLlmCompleteInputChars('openai/gpt-4o-mini');
  if (m.includes('/') || m.startsWith('Qwen/')) return getMaxElizacloudLlmCompleteInputChars(m);
  return getMaxFixPromptCharsForModel('openai', m) + ELIZACLOUD_LLM_COMPLETE_INPUT_OVERHEAD_CHARS;
}

export interface ComputeBudgetOptions {
  model?: string;
  /** Non-code prompt chars to reserve (instructions, comment, diff wrappers, etc.). */
  reservedChars: number;
  /** Split remaining code budget across N slots (e.g. N fixes in one verify batch). */
  divisor?: number;
}

export function computeBudget(opts: ComputeBudgetOptions): {
  availableForCode: number;
  inputCeilingChars: number;
} {
  const ceiling = inputCeilingCharsForModel(opts.model);
  const div = Math.max(1, opts.divisor ?? 1);
  const raw = Math.floor((ceiling - opts.reservedChars) / div);
  const available = Math.max(3_000, Math.min(raw, PROMPT_BUDGET_MAX_FULL_FILE_CHARS));
  return { availableForCode: available, inputCeilingChars: ceiling };
}

/**
 * Per-fix cap for "current code" in batch verify — aligns with buildBatchVerifyPrompt
 * (comment + diff + template overhead per fix).
 */
export function computePerFixVerifyCurrentCodeBudget(model: string | undefined, fixesInBatch: number): number {
  const n = Math.max(1, fixesInBatch);
  const overheadPerFix = 4_500;
  const batchTemplate = 12_000;
  const { availableForCode } = computeBudget({
    model,
    reservedChars: batchTemplate + n * overheadPerFix,
    divisor: n,
  });
  return Math.max(4_000, Math.min(availableForCode, 20_000));
}

export interface FitToBudgetResult {
  content: string;
  truncated: boolean;
}

/**
 * Line-numbered excerpt of `rawFileContent` within `maxChars`, centered on `anchorLine1Based`
 * when possible. Uses keyword anchor from `commentBody` when anchor is unknown.
 */
export function fitToBudget(
  rawFileContent: string,
  anchorLine1Based: number | null,
  maxChars: number,
  opts?: {
    commentBody?: string;
    findKeywordAnchor?: (lines: string[], body: string) => number | null;
  }
): FitToBudgetResult {
  const lines = rawFileContent.split('\n');
  const numbered = (from: number, to: number) =>
    lines.slice(from, to).map((l, i) => `${from + i + 1}: ${l}`).join('\n');

  let anchor = anchorLine1Based != null && anchorLine1Based > 0 && anchorLine1Based <= lines.length ? anchorLine1Based : null;
  if (anchor === null && opts?.commentBody && opts.findKeywordAnchor) {
    const k = opts.findKeywordAnchor(lines, opts.commentBody);
    if (k != null) anchor = k;
  }

  const full = numbered(0, lines.length);
  if (full.length <= maxChars) {
    return { content: full, truncated: false };
  }

  if (anchor === null) {
    const avg = 48;
    let n = Math.min(lines.length, Math.max(20, Math.floor(maxChars / avg)));
    let body = numbered(0, n);
    const note = `\n... (${formatNumber(lines.length - n)} more lines omitted — file exceeds budget; no line anchor)`;
    let out = body + note;
    if (out.length > maxChars) out = out.slice(0, maxChars - 40) + '\n... (truncated)';
    return { content: out, truncated: true };
  }

  let before = 80;
  let after = 120;
  const build = () => {
    const start = Math.max(0, anchor! - before - 1);
    const end = Math.min(lines.length, anchor! + after);
    const body = numbered(start, end);
    const foot = `\n... (excerpt — ${formatNumber(lines.length)} lines; centered on line ${formatNumber(anchor!)})`;
    return body + foot;
  };
  let text = build();
  while (text.length > maxChars && (before > 10 || after > 10)) {
    before = Math.max(10, Math.floor(before * 0.82));
    after = Math.max(10, Math.floor(after * 0.82));
    text = build();
  }
  if (text.length > maxChars) {
    text = text.slice(0, maxChars - 60) + '\n... (truncated to char budget)';
  }
  return { content: text, truncated: true };
}

/**
 * Shrink an already line-numbered snippet toward `anchorLine` to fit `maxChars`.
 * Preserves trailing "(end of file)" / "(truncated — file has …)" footer lines when present.
 */
export function truncateNumberedCodeAroundAnchor(
  rawNumberedSnippet: string,
  anchorLine: number | null | undefined,
  maxChars: number
): string {
  if (rawNumberedSnippet.length <= maxChars) return rawNumberedSnippet;
  const lines = rawNumberedSnippet.split('\n');
  const footerLines: string[] = [];
  const bodyLines = [...lines];
  while (bodyLines.length > 0) {
    const last = bodyLines[bodyLines.length - 1] ?? '';
    if (
      /^\(end of file — \d+ lines total\)\s*$/.test(last) ||
      /^\.\.\. \(truncated — file has \d+ lines total\)\s*$/.test(last)
    ) {
      footerLines.unshift(last);
      bodyLines.pop();
      continue;
    }
    break;
  }
  type Row = { lineNum: number; text: string };
  const rows: Row[] = [];
  for (const text of bodyLines) {
    const m = text.match(/^(\d+):\s?(.*)$/);
    if (m) {
      rows.push({ lineNum: parseInt(m[1]!, 10), text: m[2] ?? '' });
    }
  }
  if (rows.length === 0) {
    return rawNumberedSnippet.substring(0, Math.max(0, maxChars - 80)) + '\n... (truncated — snippet was cut for prompt size)';
  }
  let center = Math.floor(rows.length / 2);
  if (anchorLine != null && anchorLine > 0) {
    let best = 0;
    let bestDist = Infinity;
    for (let k = 0; k < rows.length; k++) {
      const d = Math.abs(rows[k]!.lineNum - anchorLine);
      if (d < bestDist) {
        bestDist = d;
        best = k;
      }
    }
    center = best;
  }
  let lo = center;
  let hi = center;
  const sliceText = () => rows.slice(lo, hi + 1).map((r) => r.text).join('\n');
  let chunk = sliceText();
  const note = '\n... (truncated — centered on review line for prompt budget)';
  const maxBody = Math.max(400, maxChars - note.length - footerLines.reduce((s, l) => s + l.length + 1, 0));
  while (chunk.length < maxBody && (lo > 0 || hi < rows.length - 1)) {
    const canHi = hi < rows.length - 1;
    const canLo = lo > 0;
    if (canHi && (!canLo || hi - center <= center - lo)) hi++;
    else if (canLo) lo--;
    else if (canHi) hi++;
    else break;
    const next = sliceText();
    if (next.length > maxBody) break;
    chunk = next;
  }
  while (chunk.length > maxBody && lo < hi) {
    if (hi - center >= center - lo) hi--;
    else lo--;
    chunk = sliceText();
  }
  if (chunk.length > maxBody) {
    chunk = chunk.substring(0, Math.max(0, maxBody - 60)) + '\n...';
  }
  const footer = footerLines.length > 0 ? '\n' + footerLines.join('\n') : '';
  return chunk + note + footer;
}
