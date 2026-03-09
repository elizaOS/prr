/**
 * Extract JSON from model response: strip markdown fences, find first balanced {...} or [...].
 * Handles braces inside JSON string literals and escaped quotes.
 */
export function extractJson<T = unknown>(raw: string): T {
  const stripped = raw
    .replace(/^\s*```\w*\n?/g, '')
    .replace(/\n?```\s*$/g, '')
    .trim();
  const firstBrace = stripped.indexOf('{');
  const firstBracket = stripped.indexOf('[');
  const start =
    firstBrace === -1
      ? firstBracket
      : firstBracket === -1
        ? firstBrace
        : Math.min(firstBrace, firstBracket);
  if (start === -1) throw new Error('No JSON object or array found in response');
  const open = stripped[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let end = start;
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
        end = i + 1;
        break;
      }
    }
  }
  const jsonStr = stripped.slice(start, end);
  return JSON.parse(jsonStr) as T;
}
