/**
 * Parse the shared prompts.log format. Delimiter: line of U+2550 (BOX DRAWINGS DOUBLE HORIZONTAL).
 * Extracts slug, type, timestamp, model, char count, token usage, content per entry.
 */
const DELIMITER = '\u2550'; // U+2550
const DELIMITER_LINE_REGEX = new RegExp(`^\\s*${DELIMITER}{10,}\\s*$`, 'gm');

export interface LogEntry {
  id: number;
  slug: string;
  type: 'PROMPT' | 'RESPONSE';
  label: string;
  timestamp: string;
  model?: string;
  charCount?: number;
  tokenUsage?: { inputTokens: number; outputTokens: number };
  content: string;
}

function parseHeaderLine(slugLine: string): { slug: string; type: 'PROMPT' | 'RESPONSE'; label: string; charCount?: number } {
  const match = slugLine.match(/#(\d+)\/([^\s]+)\s+(PROMPT|RESPONSE):\s*([^\s(]+)\s*\((\d+)\s*chars\)?/);
  if (match) {
    return {
      slug: `#${match[1].padStart(4, '0')}/${match[2]}`,
      type: match[3] as 'PROMPT' | 'RESPONSE',
      label: match[4],
      charCount: parseInt(match[5], 10),
    };
  }
  const fallback = slugLine.match(/#(\d+)\/([^\s]+)\s+(PROMPT|RESPONSE):\s*([^\n]+)/);
  if (fallback) {
    return {
      slug: `#${fallback[1].padStart(4, '0')}/${fallback[2]}`,
      type: fallback[3] as 'PROMPT' | 'RESPONSE',
      label: fallback[4].trim(),
    };
  }
  return { slug: '', type: 'PROMPT', label: '' };
}

function extractJsonBlock(lines: string[], start: number): { json: Record<string, unknown>; nextIndex: number } {
  let i = start;
  let braceCount = 0;
  let startIdx = -1;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().startsWith('{')) {
      startIdx = i;
      const trimmed = line.trim();
      for (const ch of trimmed) {
        if (ch === '{') braceCount++;
        if (ch === '}') braceCount--;
      }
      while (braceCount > 0 && i + 1 < lines.length) {
        i++;
        for (const ch of lines[i]) {
          if (ch === '{') braceCount++;
          if (ch === '}') braceCount--;
        }
      }
      const jsonStr = lines.slice(startIdx, i + 1).join('\n');
      try {
        const json = JSON.parse(jsonStr) as Record<string, unknown>;
        return { json, nextIndex: i + 1 };
      } catch {
        return { json: {}, nextIndex: start };
      }
    }
  }
  return { json: {}, nextIndex: start };
}

/**
 * Split raw prompts.log into structured entries.
 */
export function parsePromptsLog(raw: string): LogEntry[] {
  const entries: LogEntry[] = [];
  const segments = raw.split(DELIMITER_LINE_REGEX).filter((s) => s.trim().length > 0);

  let id = 0;
  for (const segment of segments) {
    const lines = segment.split('\n');
    const slugLineIdx = lines.findIndex((l) => l.trim().length > 0);
    if (slugLineIdx === -1 || slugLineIdx >= lines.length - 1) continue;
    const slugLine = lines[slugLineIdx].trim();
    if (!slugLine.includes('PROMPT') && !slugLine.includes('RESPONSE')) continue;

    const header = parseHeaderLine(slugLine);
    if (!header.slug) continue;

    id++;
    let timestamp = '';
    let model: string | undefined;
    let tokenUsage: { inputTokens: number; outputTokens: number } | undefined;
    let contentStart = slugLineIdx + 1;

    if (lines.length > contentStart && /^\d{4}-\d{2}-\d{2}T/.test(lines[contentStart].trim())) {
      timestamp = lines[contentStart].trim();
      contentStart++;
    }
    if (lines.length > contentStart && lines[contentStart].trim().startsWith('{')) {
      const { json, nextIndex } = extractJsonBlock(lines, contentStart);
      contentStart = nextIndex;
      model = json.model as string | undefined;
      const usage = json.usage as { inputTokens?: number; outputTokens?: number } | undefined;
      if (usage && typeof usage.inputTokens === 'number' && typeof usage.outputTokens === 'number') {
        tokenUsage = { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens };
      }
    }
    const content = lines.slice(contentStart).join('\n').trim();

    entries.push({
      id,
      slug: header.slug,
      type: header.type,
      label: header.label,
      timestamp,
      model,
      charCount: header.charCount,
      tokenUsage,
      content,
    });
  }
  return entries;
}
