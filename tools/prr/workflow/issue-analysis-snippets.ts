/**
 * Code snippets for review comments (read file, create-file fallbacks).
 * Part of the issue-analysis split: **`issue-analysis-snippet-helpers.ts`** holds line parsing /
 * windowed excerpts / `getFullFileForAudit`; this file wires them with context-aware snippets
 * and exports **`getCodeSnippet`** / **`buildSnippetFromRepoContent`**. Orchestrator: **`issue-analysis.ts`**.
 */
import { join } from 'path';
import { readFile } from 'fs/promises';
import {
  CODE_SNIPPET_CONTEXT_AFTER,
  CODE_SNIPPET_CONTEXT_BEFORE,
  MAX_SNIPPET_LINES,
} from '../../../shared/constants.js';
import { computeBudget } from '../../../shared/prompt-budget.js';
import { sanitizeCommentForPrompt } from '../analyzer/prompt-builder.js';
import {
  buildNumberedFullFileSnippet,
  buildWindowedSnippet,
  findAnchorLineFromCommentKeywords,
  parseLineReferencesFromBody,
} from './issue-analysis-snippet-helpers.js';
import {
  buildConservativeAnalysisSnippet,
  commentNeedsConservativeAnalysisContext,
} from './issue-analysis-context.js';

/** Build a snippet from raw file content. Used when file is not in workdir but we have content from git show. */
export function buildSnippetFromRepoContent(
  content: string,
  line: number | null,
  commentBody?: string,
  filePath = '(repo content)'
): string {
  if (commentBody && commentNeedsConservativeAnalysisContext(commentBody)) {
    const conservativeSnippet = buildConservativeAnalysisSnippet(content, filePath, line, commentBody);
    if (conservativeSnippet) return conservativeSnippet;
  }
  return buildWindowedSnippet(content, line, commentBody);
}

function isLikelyCreateFilePath(path: string): boolean {
  return /(?:^|\/)__tests__\/|(?:^|\/)[^/]+\.(?:test|spec)\.(?:ts|tsx|js|jsx)$/i.test(path);
}

function inferSourceCandidatesFromMissingTestPath(testPath: string, commentBody?: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (value: string | undefined) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    candidates.push(value);
  };

  add(testPath.replace(/\/__tests__\//g, '/').replace(/\.(test|spec)\.(ts|tsx|js|jsx)$/i, '.$2'));
  add(testPath.replace(/\.(test|spec)\.(ts|tsx|js|jsx)$/i, '.$2'));

  const referencedPaths = commentBody?.match(/`([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.(?:ts|tsx|js|jsx))`/g) ?? [];
  for (const ref of referencedPaths) add(ref.replace(/`/g, ''));

  return candidates;
}

/**
 * Build context for issues whose target file does not exist yet.
 *
 * WHY: Missing test/spec files should not degrade to the generic unreadable-file
 * placeholder. The fixer needs to see that the correct action is "create this
 * file", ideally with nearby source context when we can infer it.
 */
async function buildMissingCreateFileSnippet(
  workdir: string,
  missingPath: string,
  commentBody?: string
): Promise<string | null> {
  if (!isLikelyCreateFilePath(missingPath)) return null;

  const intro = [
    `Requested new file \`${missingPath}\` does not exist yet.`,
    'Treat this as a create-file issue and add the missing test/spec file.',
  ];

  for (const candidate of inferSourceCandidatesFromMissingTestPath(missingPath, commentBody)) {
    try {
      const content = await readFile(join(workdir, candidate), 'utf-8');
      return [
        ...intro,
        '',
        `Nearby source context from \`${candidate}\`:`,
        '',
        buildSnippetFromRepoContent(content, null, commentBody, candidate),
      ].join('\n');
    } catch {
      // Try the next candidate.
    }
  }

  if (commentBody?.trim()) {
    return [...intro, '', 'Review comment:', sanitizeCommentForPrompt(commentBody)].join('\n');
  }
  return intro.join('\n');
}

/**
 * Get code snippet from file for context
 */
export async function getCodeSnippet(
  workdir: string,
  path: string,
  line: number | null,
  commentBody?: string
): Promise<string> {
  try {
    const filePath = join(workdir, path);
    const content = await readFile(filePath, 'utf-8');
    const lines = content.split('\n');
    const { availableForCode: codeCharBudget } = computeBudget({ reservedChars: 36_000 });

    // WHY unified anchors: A comment may have comment.line=11 (GitHub API) and body text
    // "around lines 52 - 93". Using only one or the other would show the wrong code. Merging
    // all sources and taking min/max yields one contiguous range that includes every referenced line.
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

    if (startLine === null && commentBody) {
      const keywordLine = findAnchorLineFromCommentKeywords(lines, commentBody);
      if (keywordLine !== null) {
        anchors.add(keywordLine);
        startLine = keywordLine;
        endLine = keywordLine;
      }
    }

    // When the comment references lines beyond the file length, the file was likely
    // shortened/rewritten and the comment is stale. Provide the full file (if small)
    // so the verifier can see the code is gone rather than defaulting to YES.
    const maxAnchorAll = anchors.size > 0 ? Math.max(...anchors) : null;
    const commentRefsBeyondFile = maxAnchorAll !== null && maxAnchorAll > lines.length;

    // Small file or stale-reference: return entire file with (end of file) marker
    const SMALL_FILE_FULL_THRESHOLD = 250;
    if (lines.length <= SMALL_FILE_FULL_THRESHOLD || commentRefsBeyondFile) {
      const note = commentRefsBeyondFile
        ? `end of file — ${lines.length} lines total; comment references line ${maxAnchorAll} which no longer exists`
        : `end of file — ${lines.length} lines total`;
      return buildNumberedFullFileSnippet(content, note);
    }

    // Cycle 27: reply.ts gets broader snippet so judge sees enough of reply action handler (avoids STALE).
    if (path.endsWith('reply.ts') || (commentBody && commentNeedsConservativeAnalysisContext(commentBody))) {
      const conservativeSnippet = buildConservativeAnalysisSnippet(content, path, line, commentBody ?? '');
      if (conservativeSnippet) return conservativeSnippet;
    }

    if (startLine === null) {
      // No anchors: return first 50 lines
      return lines.slice(0, 50).join('\n') + `\n... (${lines.length - 50} more lines)`;
    }

    // Use union of anchors for range when we have body-derived refs
    const minAnchor = anchors.size > 0 ? Math.min(...anchors) : startLine;
    const maxAnchor = anchors.size > 0 ? Math.max(...anchors) : (endLine ?? startLine);

    let start = Math.max(0, minAnchor - CODE_SNIPPET_CONTEXT_BEFORE - 1);
    let end = Math.min(lines.length, maxAnchor + CODE_SNIPPET_CONTEXT_AFTER);

    if (end - start > MAX_SNIPPET_LINES) {
      const center = Math.floor((minAnchor + maxAnchor) / 2);
      const half = Math.floor(MAX_SNIPPET_LINES / 2);
      start = Math.max(0, center - half - 1);
      end = Math.min(lines.length, start + MAX_SNIPPET_LINES);
    }

    const shrinkCenter = Math.floor((minAnchor + maxAnchor) / 2);
    const buildSnippet = () =>
      lines
        .slice(start, end)
        .map((l, i) => `${start + i + 1}: ${l}`)
        .join('\n');
    let snippet = buildSnippet();
    while (snippet.length > codeCharBudget && end - start > 12) {
      if (end - shrinkCenter >= shrinkCenter - start) end--;
      else start++;
      snippet = buildSnippet();
    }

    // Append (end of file) when snippet reaches the last line, or truncation marker otherwise
    if (end >= lines.length) {
      return snippet + `\n(end of file — ${lines.length} lines total)`;
    }
    return snippet + `\n... (truncated — file has ${lines.length} lines total)`;
  } catch {
    const createFileSnippet = await buildMissingCreateFileSnippet(workdir, path, commentBody);
    if (createFileSnippet) return createFileSnippet;
    return '(file not found or unreadable)';
  }
}
