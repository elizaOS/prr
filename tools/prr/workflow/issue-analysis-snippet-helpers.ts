/**
 * Low-level snippet pipeline: line refs, anchor search, windowed excerpts, wider analysis snippet,
 * full-file audit text. Consumed by **`issue-analysis-snippets.ts`**, **`issue-analysis-context.ts`**,
 * and **`issue-analysis.ts`**. Higher-level **`getCodeSnippet`** lives in **`issue-analysis-snippets.ts`**.
 */
import { join } from 'path';
import { readFile } from 'fs/promises';
import { computeBudget, fitToBudget } from '../../../shared/prompt-budget.js';
import { debug } from '../../../shared/logger.js';

export function buildNumberedFullFileSnippet(content: string, note?: string): string {
  const lines = content.split('\n');
  const body = lines.map((l, i) => `${i + 1}: ${l}`).join('\n');
  return body + `\n(${note ?? `end of file — ${lines.length} lines total`})`;
}

export function parseLineReferencesFromBody(commentBody: string): number[] {
  if (!commentBody || !commentBody.trim()) return [];

  const lines = commentBody.split('\n');
  const collected: number[] = [];

  for (const raw of lines) {
    // WHY skip: CodeRabbit embeds "Script executed: sed -n '225,245p'" in the comment. Matching
    // those numbers would add 225–245 to the snippet range even though they refer to the bot's
    // script output, not the file lines the reviewer is talking about.
    if (/sed\s+-n|cat\s+-n|head\s+-n|grep\s+-n/.test(raw)) continue;

    // Around lines N - M (CodeRabbit "Prompt for AI Agents" format)
    const aroundMatch = raw.match(/around\s+lines\s+(\d+)\s*-\s*(\d+)/gi);
    if (aroundMatch) {
      for (const m of aroundMatch) {
        const parts = m.match(/(\d+)\s*-\s*(\d+)/);
        if (parts) {
          collected.push(parseInt(parts[1], 10), parseInt(parts[2], 10));
        }
      }
    }

    // lines N-M or lines N - M
    const linesDashMatch = raw.match(/\blines\s+(\d+)\s*[-–]\s*(\d+)/gi);
    if (linesDashMatch) {
      for (const m of linesDashMatch) {
        const parts = m.match(/(\d+)\s*[-–]\s*(\d+)/);
        if (parts) {
          collected.push(parseInt(parts[1], 10), parseInt(parts[2], 10));
        }
      }
    }

    // lines N to M / lines N through M
    const linesToMatch = raw.match(/\blines\s+(\d+)\s+to\s+(\d+)/gi);
    if (linesToMatch) {
      for (const m of linesToMatch) {
        const parts = m.match(/(\d+)\s+to\s+(\d+)/i);
        if (parts) {
          collected.push(parseInt(parts[1], 10), parseInt(parts[2], 10));
        }
      }
    }
    const linesThroughMatch = raw.match(/\blines\s+(\d+)\s+through\s+(\d+)/gi);
    if (linesThroughMatch) {
      for (const m of linesThroughMatch) {
        const parts = m.match(/(\d+)\s+through\s+(\d+)/i);
        if (parts) {
          collected.push(parseInt(parts[1], 10), parseInt(parts[2], 10));
        }
      }
    }

    // at line N / on line N
    const atOnMatch = raw.match(/(?:at|on)\s+line\s+(\d+)/gi);
    if (atOnMatch) {
      for (const m of atOnMatch) {
        const n = m.match(/(\d+)/);
        if (n) collected.push(parseInt(n[1], 10));
      }
    }

    // Line N (capital L, e.g. "Line 128 calls")
    const lineCapMatch = raw.match(/\bLine\s+(\d+)/g);
    if (lineCapMatch) {
      for (const m of lineCapMatch) {
        const n = m.match(/(\d+)/);
        if (n) collected.push(parseInt(n[1], 10));
      }
    }

    // line N (word boundary avoids "pipeline", "deadline")
    const lineMatch = raw.match(/\bline\s+(\d+)/gi);
    if (lineMatch) {
      for (const m of lineMatch) {
        const n = m.match(/(\d+)/);
        if (n) collected.push(parseInt(n[1], 10));
      }
    }

    // #LN or #LN-LM (LOCATIONS-style)
    const hashMatch = raw.match(/#L(\d+)(?:-L(\d+))?/g);
    if (hashMatch) {
      for (const m of hashMatch) {
        const parts = m.match(/#L(\d+)(?:-L(\d+))?/);
        if (parts) {
          collected.push(parseInt(parts[1], 10));
          if (parts[2]) collected.push(parseInt(parts[2], 10));
        }
      }
    }
  }

  const unique = [...new Set(collected)].filter((n) => n > 0);
  unique.sort((a, b) => a - b);
  return unique;
}

/** Extract code-like tokens from comment body to anchor snippet when no line number. Prompts.log audit: first 80 lines showed only imports/class header; buggy code was deeper. */
export function findAnchorLineFromCommentKeywords(lines: string[], commentBody: string | undefined): number | null {
  if (!commentBody || lines.length === 0) return null;
  const tokens: string[] = [];
  const backtickRe = /`([a-zA-Z_][a-zA-Z0-9_.]*?)`/g;
  let m: RegExpExecArray | null;
  while ((m = backtickRe.exec(commentBody)) !== null) {
    if (m[1].length > 2) tokens.push(m[1]);
  }
  const snakeCamelRe = /\b([a-z]+_[a-z0-9_]+|[a-z][a-z0-9]*[A-Z][a-zA-Z0-9]*)\b/g;
  while ((m = snakeCamelRe.exec(commentBody)) !== null) {
    if (m[1].length > 3) tokens.push(m[1]);
  }
  const seen = new Set<string>();
  const unique = tokens.filter((t) => {
    if (seen.has(t)) return false;
    seen.add(t);
    return true;
  });
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const token of unique) {
      if (token.length < 4) continue;
      const re = new RegExp(`\\b${escapeRegExpForSnippet(token)}\\b`);
      if (re.test(line)) return i + 1;
    }
  }
  return null;
}

export function escapeRegExpForSnippet(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse anchors from line + commentBody, then fill model-aware char budget with a line-centered excerpt.
 */
export function buildWindowedSnippet(
  fileContent: string,
  line: number | null,
  commentBody?: string,
  modelId?: string
): string {
  const lines = fileContent.split('\n');
  const anchors = new Set<number>();
  if (line !== null) anchors.add(line);
  let startLine: number | null = line;
  let endLine: number | null = line;
  if (startLine === null && commentBody) {
    const locationsMatch = commentBody.match(/LOCATIONS START\s*([\s\S]*?)\s*LOCATIONS END/);
    if (locationsMatch) {
      const locationLines = locationsMatch[1].trim().split('\n');
      for (const loc of locationLines) {
        const lineMatch = loc.match(/#L(\d+)(?:-L(\d+))?/);
        if (lineMatch) {
          startLine = parseInt(lineMatch[1], 10);
          endLine = lineMatch[2] ? parseInt(lineMatch[2], 10) : startLine + 20;
          anchors.add(startLine);
          if (endLine !== null) anchors.add(endLine);
          break;
        }
      }
    }
  }
  if (commentBody) {
    const fromBody = parseLineReferencesFromBody(commentBody);
    fromBody.forEach((n) => anchors.add(n));
    if (fromBody.length > 0 && startLine === null) {
      startLine = fromBody[0]!;
      endLine = fromBody[fromBody.length - 1]!;
    }
  }
  if (startLine === null && anchors.size === 0 && commentBody) {
    const keywordLine = findAnchorLineFromCommentKeywords(lines, commentBody);
    if (keywordLine !== null) {
      anchors.add(keywordLine);
      startLine = keywordLine;
      endLine = keywordLine;
    }
  }

  let centerLine: number | null = null;
  if (anchors.size > 0) {
    centerLine = Math.floor((Math.min(...anchors) + Math.max(...anchors)) / 2);
  } else if (line !== null) {
    centerLine = line;
  }

  const { availableForCode } = computeBudget({ model: modelId, reservedChars: 26_000 });
  const { content } = fitToBudget(fileContent, centerLine, availableForCode, {
    commentBody,
    findKeywordAnchor: findAnchorLineFromCommentKeywords,
  });
  return content;
}

/**
 * Return a wider file excerpt for batch analysis when the normal snippet is too short.
 * Gives the verifier enough context to avoid "snippet truncated; cannot verify" YES responses.
 * Uses same anchor logic as getCodeSnippet (line + commentBody LOCATIONS + parseLineReferencesFromBody) so the window is centered on the relevant range.
 */
export async function getWiderSnippetForAnalysis(
  workdir: string,
  path: string,
  line: number | null,
  commentBody?: string
): Promise<string> {
  try {
    const filePath = join(workdir, path);
    const content = await readFile(filePath, 'utf-8');
    return buildWindowedSnippet(content, line, commentBody);
  } catch {
    return '(file not found or unreadable)';
  }
}

/**
 * Get full file content for final audit so the LLM sees complete context
 * instead of truncated snippets that can cause false "UNFIXED" verdicts.
 *
 * When the raw file is larger than **`computeBudget`** allows for this call, returns a
 * **line-centered numbered excerpt** via **`fitToBudget`** (review line, or keyword anchor from
 * **`commentBody`**, else a short head slice with an explicit “no line anchor” footer).
 * **WHY:** A fixed char cap per file is not enough — small-context models need a smaller excerpt
 * than large-context models; and head-only truncation hid tail bugs → false UNFIXED
 * (pill-output / final-audit cluster). Pass **`modelId`** when known so the budget matches the
 * final-audit model’s gateway limit.
 */
export interface FullFileForAuditResult {
  snippet: string;
  /** True when the GitHub review anchor is inside the shown window (full file or line-centered excerpt). */
  fixSiteInWindow: boolean;
}

function finalAuditFileContextHeader(params: {
  totalLines: number;
  mode: 'full' | 'excerpt';
  anchorLine: number | null;
  truncated: boolean;
}): string {
  const { totalLines, mode, anchorLine, truncated } = params;
  const anchorNote =
    anchorLine != null
      ? `Review anchor ~line ${anchorLine}.`
      : 'No line anchor — excerpt may start at file head.';
  if (mode === 'full') {
    return `[PRR final-audit context] Complete numbered file below (${totalLines} lines total).\n\n`;
  }
  return (
    `[PRR final-audit context] File has ${totalLines} lines total. ` +
    `Below is a ${truncated ? 'budget-limited excerpt' : 'numbered view'} (${anchorNote}) ` +
    `If the fix may be outside this window, prefer UNCERTAIN over UNFIXED without citing lines from the snippet.\n\n`
  );
}

export async function getFullFileForAudit(
  workdir: string,
  path: string,
  line?: number | null,
  commentBody?: string,
  modelId?: string
): Promise<FullFileForAuditResult> {
  const missing: FullFileForAuditResult = { snippet: '(file not found or unreadable)', fixSiteInWindow: false };
  try {
    const filePath = join(workdir, path);
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');

    const { availableForCode } = computeBudget({ model: modelId, reservedChars: 16_000 });
    if (content.length <= availableForCode) {
      const body = lines.map((l, i) => `${i + 1}: ${l}`).join('\n');
      return {
        snippet: finalAuditFileContextHeader({ totalLines: lines.length, mode: 'full', anchorLine: null, truncated: false }) + body,
        fixSiteInWindow: true,
      };
    }

    let anchorLine = line != null && line > 0 && line <= lines.length ? line : null;
    if (anchorLine === null && commentBody) {
      anchorLine = findAnchorLineFromCommentKeywords(lines, commentBody);
    }

    const { content: excerpt, truncated } = fitToBudget(content, anchorLine, availableForCode, {
      commentBody,
      findKeywordAnchor: findAnchorLineFromCommentKeywords,
    });
    if (truncated) {
      debug('getFullFileForAudit: line-centered or head excerpt (budget)', {
        path,
        lineCount: lines.length,
        anchorLine,
        truncated,
        excerptChars: excerpt.length,
        availableForCode,
      });
    }
    const fixSiteInWindow = !truncated || anchorLine != null;
    const header = finalAuditFileContextHeader({
      totalLines: lines.length,
      mode: 'excerpt',
      anchorLine,
      truncated,
    });
    return { snippet: header + excerpt, fixSiteInWindow };
  } catch {
    return missing;
  }
}
