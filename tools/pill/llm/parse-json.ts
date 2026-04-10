/**
 * Extract JSON from model response: strip markdown fences, find first balanced {...} or [...].
 * Handles braces inside JSON string literals and escaped quotes.
 */

function stripMarkdownFences(raw: string): string {
  return raw.replace(/^\s*```\w*\n?/g, '').replace(/\n?```\s*$/g, '').trim();
}

/** Balanced slice from `start` (must be `{` or `[`). Returns null if unclosed. */
function sliceBalancedJson(stripped: string, start: number): string | null {
  const open = stripped[start];
  if (open !== '{' && open !== '[') return null;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (inString) {
      if (ch === '\\') {
        i++;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === open) depth++;
    if (ch === close) {
      depth--;
      if (depth === 0) {
        return stripped.slice(start, i + 1);
      }
    }
  }
  return null;
}

export function extractJson<T = unknown>(raw: string): T {
  const stripped = stripMarkdownFences(raw);
  const firstBrace = stripped.indexOf('{');
  const firstBracket = stripped.indexOf('[');
  const start =
    firstBrace === -1
      ? firstBracket
      : firstBracket === -1
        ? firstBrace
        : Math.min(firstBrace, firstBracket);
  if (start === -1) throw new Error('No JSON object or array found in response');
  const jsonStr = sliceBalancedJson(stripped, start);
  if (!jsonStr) throw new Error('Unbalanced JSON in response');
  return JSON.parse(jsonStr) as T;
}

/**
 * Like {@link extractJson}, but if the first `{` opens a non-JSON or truncated object (e.g. model
 * echoed `[DIRECTORY TREE]` prose before the real payload), retry from each `{` that starts with
 * `"pitch"`, `"summary"`, or `"improvements"`.
 * WHY: Pill audit user messages include `[DIRECTORY TREE]`; models sometimes prepend text so the
 * first `{` is wrong — JSON.parse then fails with errors like `Unexpected identifier "DIRECTORY"`.
 */
export function extractJsonLenient<T = unknown>(raw: string): T {
  try {
    return extractJson<T>(raw);
  } catch {
    const stripped = stripMarkdownFences(raw);
    const keyPattern = /\{\s*"(?:pitch|summary|improvements)"/g;
    let m: RegExpExecArray | null;
    while ((m = keyPattern.exec(stripped)) !== null) {
      const jsonStr = sliceBalancedJson(stripped, m.index);
      if (jsonStr) {
        try {
          return JSON.parse(jsonStr) as T;
        } catch {
          /* try next candidate */
        }
      }
    }
    throw new Error('No valid JSON object found in pill audit response');
  }
}
