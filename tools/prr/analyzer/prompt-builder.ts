import type { UnresolvedIssue, FixPrompt } from './types.js';
import type { BotRiskEntry } from '../workflow/bot-risk.js';
import { formatLessonForDisplay } from '../state/lessons-normalize.js';
import { MAX_ISSUES_PER_PROMPT, MIN_ISSUES_PER_PROMPT, MAX_COMMENT_CHARS, MAX_SNIPPET_LINES } from '../../../shared/constants.js';
import { filterAllowedPathsForFix, isPathAllowedForFix } from '../../../shared/path-utils.js';
import { SNIPPET_PLACEHOLDER } from '../workflow/helpers/solvability.js';

/**
 * Strip HTML noise, base64 JWT links, and metadata from PR comment bodies
 * before including them in LLM prompts.
 *
 * WHY: Bot comments (Cursor bugbot, CodeRabbit) include "Fix in Cursor" links
 * with 600+ char base64 JWT tokens, HTML comments with bugbot UUIDs, <picture>
 * tags, etc. This wastes 20-30% of prompt tokens on data the LLM can't use
 * and often confuses it.
 *
 * Keeps: The actual issue description text, code suggestions, markdown.
 * Strips: JWT links, HTML comments, LOCATIONS blocks, <picture>/<img> tags.
 */
export function sanitizeCommentForPrompt(body: string): string {
  let s = body;

  // 1. Remove "Fix in Cursor" / "Fix in Web" anchor+picture blocks.
  //    These are <p><a href="...cursor.com/open?data=eyJ..."><picture>...</picture></a>...</p>
  //    and can be 1000+ chars each.  Match the whole <p>..cursor.com/open?data=..</p> block.
  s = s.replace(/<p>\s*<a\s+href="https?:\/\/cursor\.com\/[^"]*"[^>]*>[\s\S]*?<\/a>(?:&nbsp;|\s)*(?:<a\s+href="https?:\/\/cursor\.com\/[^"]*"[^>]*>[\s\S]*?<\/a>\s*)*<\/p>/gi, '');

  // 2. Remove HTML comments: <!-- BUGBOT_BUG_ID: ... -->, <!-- LOCATIONS START ... LOCATIONS END -->
  //    Keep the text between DESCRIPTION START/END markers but remove the markers themselves.
  s = s.replace(/<!--\s*LOCATIONS START[\s\S]*?LOCATIONS END\s*-->/gi, '');
  s = s.replace(/<!--\s*BUGBOT_BUG_ID:[^>]*-->/gi, '');
  s = s.replace(/<!--\s*suggestion_start\s*-->/gi, '');
  s = s.replace(/<!--\s*DESCRIPTION START\s*-->/gi, '');
  s = s.replace(/<!--\s*DESCRIPTION END\s*-->/gi, '');
  // Catch any remaining HTML comments
  s = s.replace(/<!--[\s\S]*?-->/g, '');

  // 3. Remove <details> blocks that contain "Committable suggestion" (rendered code suggestion buttons)
  s = s.replace(/<details>\s*<summary>\s*📝\s*Committable suggestion[\s\S]*?<\/details>/gi, '');

  // 4. Remove stray <details>/<summary> tags but keep their text content
  s = s.replace(/<\/?details>/gi, '');
  s = s.replace(/<\/?summary>/gi, '');

  // 5. Remove any remaining <picture>, <source>, <img> tags
  s = s.replace(/<picture>[\s\S]*?<\/picture>/gi, '');
  s = s.replace(/<source[^>]*>/gi, '');
  s = s.replace(/<img[^>]*>/gi, '');

  // 6. Remove standalone <p> and </p> tags (keep content)
  s = s.replace(/<\/?p>/gi, '');

  // 7. Remove orphaned <a> tags pointing to cursor.com (residual from partial matches)
  s = s.replace(/<a\s+href="https?:\/\/cursor\.com\/[^"]*"[^>]*>[^<]*<\/a>/gi, '');

  // 8. Collapse runs of 3+ blank lines to 2
  s = s.replace(/\n{3,}/g, '\n\n');

  // 9. Strip CodeRabbit "Analysis chain" and "Script executed" blocks.
  // WHY: CodeRabbit embeds 5–15 shell script runs (rg, cat, head, etc.) with Repository/Length metadata.
  // Each block is 200–1500 chars; one comment had 11 blocks (~3.5k chars). The analyzer only needs
  // the actual finding (e.g. "**Align CACHE_TTL keys**" or "Suggested fix"); script output is noise.
  s = s.replace(/\s*🏁\s*Script executed:\s*```[\s\S]*?```\s*Repository:[\s\S]*?Length of output:[^\n]*\n?(\s*---\n?)?/g, '');
  s = s.replace(/\s*🧩\s*Analysis chain\s*\n*/gi, '\n\n');

  // 10. Strip Vercel deployment tokens ([vc]: #... or [vc]: base64:...) — prompts.log audit: 400+ char blobs in every fix prompt.
  s = s.replace(/\[vc\]:\s*#?[A-Za-z0-9+/=]{20,}(?::[A-Za-z0-9+/=]+)?/g, '[vc]: (token omitted)');

  return s.trim();
}

/**
 * Escape nested ``` inside review comments so the fix prompt doesn't have triple-backtick confusion.
 * WHY: Review comments often contain GitHub ```suggestion blocks; when we wrap the whole comment in ```,
 * we get nested ``` which can confuse models (audit: prompts.log).
 */
export function escapeSuggestionBlocksInComment(body: string): string {
  return body.replace(/```suggestion\b([\s\S]*?)```/gi, '~~~suggestion$1~~~');
}

/**
 * Estimate token count for a string.
 * WHY: Anthropic has 200k token limit. We need to detect when prompts are too large.
 * Rough estimate: 1 token ≈ 4 characters (conservative for English text)
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Refactor/duplication keywords in comment or verifier text → allow broader changes for that issue */
const REFACTOR_KEYWORDS = /\b(duplicate[sd]?|duplication|refactor(?:ing)?|share\s+logic|consolidate|extract\s+(?:common|shared)|remove\s+duplication|redundant)\b/i;

/**
 * Detect whether an issue likely requires refactoring (e.g. removing duplication, sharing logic).
 * When true, we relax "minimal only" / "do not reorganize" for that issue so the fixer can consolidate code.
 *
 * Signals: triage ease 4–5 (complex/major refactor), or comment/verifier text mentioning
 * duplicate, refactor, share logic, consolidate, extract common, etc.
 */
export function issueRequiresRefactor(issue: UnresolvedIssue): boolean {
  if (issue.triage && issue.triage.ease >= 4) return true;
  const body = issue.comment?.body ?? '';
  if (REFACTOR_KEYWORDS.test(body)) return true;
  if (issue.verifierContradiction && REFACTOR_KEYWORDS.test(issue.verifierContradiction)) return true;
  return false;
}

/** True if the review comment or explanation asks for adding/updating tests (so we allow __tests__/). Exported for allow-path persistence when fixer attempts a test file. */
export function issueRequestsTests(issue: UnresolvedIssue): boolean {
  const text = `${issue.comment?.body ?? ''} ${issue.explanation ?? ''}`;
  return /\b(?:add(?:ing)?|writing|no\s+tests?\s+cover|tests?\s+cover|test\s+coverage)\s+(?:tests?|here|for)\b/i.test(text) ||
         /\b__tests__\b/i.test(text) ||
         /\b(?:vitest|jest|mocha)\b/i.test(text) ||
         /\badding\s+tests?\s+here\s+would\s+help\b/i.test(text);
}

/** If the issue is on a test file and mentions lesson-normalize impl, return the impl path so the fixer may edit it. Audit: test-file issues (e.g. normalize-lesson-text.test.ts) need impl changes in tools/prr/state/lessons-normalize.ts. Exported for single-issue prompt. */
export function getImplPathForTestFileIssue(issue: UnresolvedIssue, fileLessons: string[] | undefined): string | null {
  if (!/\.test\.(ts|js)$/.test(issue.comment.path)) return null;
  const text = `${issue.comment.body ?? ''} ${(fileLessons ?? []).join(' ')}`;
  if (/\b(?:normalizeLessonText|sanitizeLessonText|lessons-normalize)\b/i.test(text)) return 'tools/prr/state/lessons-normalize.ts';
  return null;
}

/**
 * When the issue is on a source file but the review asks for tests in another file (e.g. "add tests in component.test.ts"),
 * return that test file path so we can add it to TARGET FILE(S) and avoid UNCLEAR loops. Exported for single-issue and no-changes.
 * When pathExists is provided, prefers co-located path if it exists, otherwise falls back to __tests__/integration/ (for projects using that layout).
 */
export function getTestPathForSourceFileIssue(
  issue: UnresolvedIssue,
  options?: { pathExists?: (path: string) => boolean }
): string | null {
  const pathExists = options?.pathExists;
  if (!issueRequestsTests(issue)) return null;
  const path = issue.comment.path ?? '';
  const body = issue.comment.body ?? '';
  // Already on a test file — no need to infer another test path
  if (/\.(test|spec)\.(ts|js)$/.test(path)) return null;
  const dir = path.includes('/') ? path.replace(/\/[^/]+$/, '') : '';
  const norm = (p: string) => p.replace(/\/\.\//g, '/').replace(/\/[^/]+\/\.\.\//g, '/');
  const preferOrFallback = (colocated: string, integration: string | null): string => {
    if (pathExists) {
      if (pathExists(colocated)) return colocated;
      if (integration && pathExists(integration)) return integration;
    }
    return colocated;
  };
  // Explicit test file path in body (e.g. "__tests__/integration/component.test.ts")
  const explicitFull = body.match(/(?:^|[\s(])`?([a-zA-Z0-9_/.()-]+__tests__[a-zA-Z0-9_/.()-]+\.(?:test|spec)\.(?:ts|js))`?(?:\s|$|[,)])/);
  if (explicitFull?.[1]) return explicitFull[1].replace(/^[\s(]+|[\s)]+$/g, '');
  const explicitRel = body.match(/(?:in|to|add\s+tests?\s+to?|tests?\s+in)\s+[`']?([a-zA-Z0-9_/.()-]+\.(?:test|spec)\.(?:ts|js))[`']?(?:\s|$|[,)])/i);
  if (explicitRel?.[1]) {
    const name = explicitRel[1].replace(/^[\s'`]+|[\s'`]+$/g, '');
    if (name.includes('/')) return name;
    if (dir) {
      const colocated = norm(`${dir}/${name}`);
      const integration = norm(`${dir}/../__tests__/integration/${name}`);
      return preferOrFallback(colocated, integration);
    }
    return name;
  }
  const backtick = body.match(/`([a-zA-Z0-9_/.()-]+\.(?:test|spec)\.(?:ts|js))`/);
  if (backtick?.[1]) {
    const name = backtick[1];
    if (name.includes('/')) return name;
    if (dir) {
      const colocated = norm(`${dir}/${name}`);
      const integration = norm(`${dir}/../__tests__/integration/${name}`);
      return preferOrFallback(colocated, integration);
    }
    return name;
  }
  // Convention: co-located <sourceBase>.test.ts, with __tests__/integration fallback when pathExists says colocated doesn't exist
  const base = path.replace(/^.*\//, '').replace(/\.(ts|js)$/, '.test.$1');
  if (dir) {
    const colocated = norm(`${dir}/${base}`);
    const integration = norm(`${dir}/../__tests__/integration/${base}`);
    return preferOrFallback(colocated, integration);
  }
  return base;
}

/** When the review says a migration is missing from the journal, the fix must edit db/migrations/meta/_journal.json (Drizzle Kit discovers migrations via that JSON). Returns that path if the issue is about migration journal. */
export function getMigrationJournalPath(issue: UnresolvedIssue): string | null {
  const path = issue.comment.path ?? '';
  const body = issue.comment.body ?? '';
  if (!/^db\/migrations\/[^/]+\.sql$/i.test(path)) return null;
  if (!/_journal\.json/i.test(body) && !/\bjournal\s+to\s+discover\b/i.test(body)) return null;
  return 'db/migrations/meta/_journal.json';
}

/** True if the code excerpt is too short or placeholder-like (causes WRONG_LOCATION). Exported for analysis batch to expand before sending to verifier. */
export function isSnippetTooShort(snippet: string): boolean {
  if (snippet.length < 80) return true;
  const lines = snippet.split('\n').map((l) => l.replace(/^\s*\d+\s*:\s*/, '').trim());
  const meaningful = lines.filter((l) => l.length > 0 && !/^\.{1,3}\s*$/.test(l));
  return meaningful.length <= 1;
}

/** When the issue is about consolidating a duplicate (extract to shared / remove duplication) and the comment names another file that contains the duplicate, return that path so we can add it to allowedPaths. Enables fixer to remove the duplicate from both files. */
export function getConsolidateDuplicateTargetPath(issue: UnresolvedIssue): string | null {
  if (!issueRequiresRefactor(issue)) return null;
  const commentPath = issue.comment.path ?? '';
  const body = issue.comment.body ?? '';
  // Match all repo-relative paths (e.g. lib/.../file.ts); return first that is not comment.path and not the shared util
  const pathRegex = /(?:lib|app|tools|src)\/[a-zA-Z0-9/_.-]+\.(?:ts|tsx|js|jsx)/g;
  for (const m of body.matchAll(pathRegex)) {
    const candidate = m[0];
    if (candidate === commentPath) continue;
    // Don't add the shared util itself (e.g. db-errors.ts) — we're adding the "other file" that has the duplicate
    if (/lib\/utils\/db-errors\.(ts|js)$/i.test(candidate)) continue;
    return candidate;
  }
  return null;
}

/**
 * Basename collision: when the comment is on a short path (e.g. "reporting.py") but the body
 * references the same basename at a different full path (e.g. "benchmarks/bfcl/reporting.py"),
 * return that full path so we add it to allowedPaths and the fixer edits the correct file.
 */
export function getReferencedFullPathFromComment(issue: UnresolvedIssue): string | null {
  const commentPath = issue.comment.path ?? '';
  const body = issue.comment.body ?? '';
  const base = commentPath.replace(/^.*\//, '');
  if (!base) return null;
  // Lookahead for trailing boundary so paths followed by , . : ; ) etc. still match
  const pathLikeRe = /(?:^|[\s`'(])([a-zA-Z0-9][a-zA-Z0-9_/.()-]*\/[a-zA-Z0-9_/.()-]+)(?=[\s`'),.:;]|$)/g;
  let m: RegExpExecArray | null;
  while ((m = pathLikeRe.exec(body)) !== null) {
    const full = m[1];
    const candidateBasename = full.replace(/^.*\//, '');
    if (candidateBasename === base && full !== commentPath) return full;
  }
  return null;
}

/**
 * When the issue body explicitly mentions a documentation file (e.g. DATABASE_API_README.md,
 * README.md, design doc) that differs from the comment path, return it so we add it to
 * allowedPaths — fixes "wrong file" loops when the fix requires both code and docs.
 */
export function getDocumentationPathFromComment(issue: UnresolvedIssue): string | null {
  const commentPath = issue.comment.path ?? '';
  const body = issue.comment.body ?? '';
  const pathRegex = /(?:^|[\s`'(])((?:[a-zA-Z0-9_/.()-]+\/)?[A-Za-z0-9_.-]*(?:README|DESIGN|design|docs?\/[a-zA-Z0-9_/.()-]+)\.[a-zA-Z0-9]+)(?:[\s`')]|$)/g;
  for (const m of body.matchAll(pathRegex)) {
    const candidate = m[1].replace(/^[\s`'(]+|[\s`')]+$/g, '');
    if (candidate && candidate !== commentPath && /\.(md|mdx|txt)$/i.test(candidate)) return candidate;
  }
  if (/\b(?:README|documentation|design\s+doc)\b/i.test(body)) {
    const backtickPath = body.match(/`([a-zA-Z0-9_/.()-]+\.(?:md|mdx|txt))`/);
    if (backtickPath?.[1] && backtickPath[1] !== commentPath) return backtickPath[1];
  }
  return null;
}

/** Same trigger as mentionsDeleteOrStray; used by getPathsToDeleteFromCommentBody. */
function bodyMentionsDeleteOrStray(body: string): boolean {
  return /\b(?:delete|remove from repo|stray|garbage file|should not be in the repo|mistakenly committed|remove (?:these?|the) files?)\b/i.test(body);
}

/**
 * Extract file paths from a comment body when it lists files to delete/remove (e.g. stray files).
 * Used at issue creation so allowedPaths can include all listed paths. Only runs when body
 * mentions delete/remove/stray/garbage so we don't pull random paths from other issues.
 */
export function getPathsToDeleteFromCommentBody(body: string): string[] {
  if (!body || !bodyMentionsDeleteOrStray(body)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  // Bullet lines with backtick-wrapped path: - `path` or - `path` - description
  const backtickRe = /^[\s]*[-*]\s*`([^`]+)`/gm;
  let m: RegExpExecArray | null;
  while ((m = backtickRe.exec(body)) !== null) {
    const p = m[1].trim();
    if (p && (p.includes('/') || /\.(ts|tsx|js|jsx|py|json)$/i.test(p) || /^[a-zA-Z0-9_.-]+$/i.test(p)) && !seen.has(p)) {
      seen.add(p);
      if (isPathAllowedForFix(p)) out.push(p);
    }
  }
  // Bullet lines with path not in backticks: - path or - path - description (path has extension or slash)
  const plainRe = /^[\s]*[-*]\s+([a-zA-Z0-9][a-zA-Z0-9/_.-]*\.(?:ts|tsx|js|jsx|py|json)|[a-zA-Z0-9][a-zA-Z0-9/_.-]*\/[a-zA-Z0-9/_.-]+)(?:\s|$)/gm;
  while ((m = plainRe.exec(body)) !== null) {
    const p = m[1].trim();
    if (p && !seen.has(p) && isPathAllowedForFix(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/**
 * When the comment body lists files to delete/remove (e.g. "Stray files: - 10/route.ts - 50/route.ts"),
 * return those paths so we can add them to allowedPaths and the runner will accept <deletefile path="..."/>.
 */
export function getPathsToDeleteFromComment(issue: UnresolvedIssue): string[] {
  return getPathsToDeleteFromCommentBody(issue.comment.body ?? '');
}

/**
 * When the comment body mentions sibling files by name (e.g. "entity.store.ts and task.store.ts"),
 * return repo-relative paths in the same directory as the issue file so we can add them to
 * allowedPaths. Enables fixer to edit the files that actually contain the issue.
 */
export function getSiblingFilePathsFromComment(issue: UnresolvedIssue): string[] {
  const primaryPath = issue.resolvedPath ?? issue.comment.path ?? '';
  const dir = primaryPath.includes('/') ? primaryPath.replace(/\/[^/]+$/, '') : '';
  const primaryBasename = primaryPath.replace(/^.*\//, '');
  const body = issue.comment.body ?? '';
  const seen = new Set<string>();
  const out: string[] = [];
  const re = /\b([a-zA-Z0-9_.-]+\.(?:ts|tsx|js|jsx|py))\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const basename = m[1];
    if (basename === primaryBasename) continue;
    const full = dir ? `${dir}/${basename}` : basename;
    if (seen.has(full)) continue;
    seen.add(full);
    if (isPathAllowedForFix(full)) out.push(full);
  }
  return out;
}

/**
 * Compute effective batch size using adaptive batching.
 *
 * WHY: When the fixer repeatedly fails to fix any issues, the batch is likely
 * too large for the model to handle effectively. Halving after each zero-fix
 * iteration lets the system converge on a manageable size before falling back
 * to single-issue focus mode.
 *
 * @param consecutiveZeroFixIterations Number of consecutive iterations with 0 verified fixes
 * @returns Effective max issues for this prompt
 */
export function computeEffectiveBatchSize(consecutiveZeroFixIterations: number): number {
  if (consecutiveZeroFixIterations <= 0) return MAX_ISSUES_PER_PROMPT;
  // Halve the batch size for each consecutive zero-fix iteration
  // e.g. 50 → 25 → 12 → 6 → 5 (clamped to MIN)
  const reduced = Math.floor(MAX_ISSUES_PER_PROMPT / Math.pow(2, consecutiveZeroFixIterations));
  return Math.max(MIN_ISSUES_PER_PROMPT, reduced);
}

export function buildFixPrompt(
  issues: UnresolvedIssue[],
  lessonsLearned: string[],
  options?: {
    maxIssues?: number;
    /**
     * Per-file lesson lookup for inline injection alongside each issue.
     *
     * HISTORY: Originally lessons were only shown in a top-level "Lessons
     * Learned" section, 2000+ tokens before the issue they apply to. The
     * fixer kept ignoring file-specific lessons (e.g. "delete lines 429-506"
     * for verify/route.ts) because by the time it processed that issue, the
     * lesson was out of its attention window. Now file-specific lessons are
     * ALSO injected inline right after the issue's code snippet, so the fixer
     * sees them in immediate context.
     */
    perFileLessons?: Map<string, string[]>;
    /**
     * PR metadata injected into the prompt so the fixer understands what the
     * PR is trying to accomplish, not just individual review comments.
     *
     * WHY: Without this context, a fixer seeing "incorrect error handling in
     * the auth flow" has no idea the PR is adding OAuth2 PKCE for mobile.
     * The fix might be technically valid but semantically wrong for the PR's
     * intent. Including title, description, and base branch gives the fixer
     * the big picture.
     */
    prInfo?: { title: string; body: string; baseBranch: string };
    /**
     * Output of `git diff base...HEAD --stat` run by the workflow.
     * Injected so the fixer sees what files/lines this PR changes without
     * needing shell access (e.g. llm-api runner).
     */
    diffStat?: string;
    /**
     * Per-file bot comment counts (from summarizeBotRiskByFile).
     * When a file has total >= 2, we add a note so the fixer is more thorough there.
     */
    botRiskByFile?: Map<string, BotRiskEntry>;
    /**
     * When provided, used to resolve test file paths (e.g. colocated vs __tests__/integration)
     * so TARGET FILE(S) point to the path that actually exists. Reduces wrong-file loops when
     * the review says "add tests in component.test.ts" and the test lives in __tests__/.
     */
    pathExists?: (path: string) => boolean;
  }
): FixPrompt {
  // Guard: Return empty prompt if no issues
  // WHY: Prevents confusing "Fixing 0 issues" output and wasted fixer runs
  if (issues.length === 0) {
    return {
      prompt: '',
      summary: 'No issues to fix',
      detailedSummary: 'No issues to fix',
      lessonsIncluded: 0,
      issues: [],
    };
  }

  // Cap lessons to prevent prompt bloat (73+ lessons = prompt poisoning).
  const MAX_LESSONS = 15;
  // WHY large-batch cap: With 10+ issues, 15 lessons + full content produced 278k+ char prompts and
  // gateway timeouts; 5 global + 1 per-file keeps prompts under ~100k chars while still surfacing recent failures.
  const lessonCap = issues.length > 10 ? 5 : MAX_LESSONS;

  // Limit issues per prompt to prevent token overflow
  // WHY: 124 issues at once = 202k tokens which exceeds Anthropic's 200k limit
  // The effective limit may be reduced by adaptive batching when consecutive iterations fail.
  // Treat maxIssues === 0 as unlimited (return full array). Coerce and clamp other values
  // so negative/NaN don't produce bad slices (e.g. issues.slice(0, -1)).
  const requestedMax = options?.maxIssues;
  const effectiveMax =
    requestedMax === 0
      ? Infinity
      : (Number.isFinite(Number(requestedMax))
          ? Math.min(MAX_ISSUES_PER_PROMPT, Math.max(1, Math.floor(Number(requestedMax))))
          : MAX_ISSUES_PER_PROMPT);
  const originalCount = issues.length;
  const limitedIssues = effectiveMax === Infinity ? issues : issues.slice(0, effectiveMax);
  const wasLimited = originalCount > effectiveMax;

  const parts: string[] = [];

  parts.push('# Code Review Issues to Fix\n');
  if (wasLimited) {
    parts.push(`Processing first ${limitedIssues.length} of ${originalCount} issues (batched to prevent token overflow).\n`);
    parts.push('Please address the following code review issues.\n');
  } else {
    parts.push('Please address the following code review issues.\n');
  }

  // Build a short summary for console output
  const fileSet = new Set(limitedIssues.map((i) => i.resolvedPath ?? i.comment.path));
  const files = Array.from(fileSet);
  const filesSummary = files.length <= 3 
    ? files.map(f => f.split('/').pop()).join(', ')  // Just filename
    : `${files.slice(0, 2).map(f => f.split('/').pop()).join(', ')} +${files.length - 2} more`;
  
  const authors = Array.from(new Set(limitedIssues.map(i => i.comment.author)));
  const authorsSummary = authors.length <= 2 
    ? authors.join(', ') 
    : `${authors.slice(0, 2).join(', ')} +${authors.length - 2} more`;

  // Group issues by type of comment (look for keywords)
  const issueTypes: string[] = [];
  const bodies = limitedIssues.map(i => i.comment.body.toLowerCase());
  if (bodies.some(b => b.includes('error') || b.includes('bug') || b.includes('fix'))) issueTypes.push('bugs');
  if (bodies.some(b => b.includes('type') || b.includes('typescript'))) issueTypes.push('types');
  if (bodies.some(b => b.includes('test'))) issueTypes.push('tests');
  if (bodies.some(b => b.includes('security') || b.includes('auth'))) issueTypes.push('security');
  if (bodies.some(b => b.includes('performance') || b.includes('optimize'))) issueTypes.push('perf');
  if (bodies.some(b => b.includes('style') || b.includes('format') || b.includes('lint'))) issueTypes.push('style');
  
  const typesStr = issueTypes.length > 0 ? ` (${issueTypes.join(', ')})` : '';

  const summaryIssueCount = wasLimited ? `${limitedIssues.length}/${originalCount}` : `${limitedIssues.length}`;
  const summary = `Fixing ${summaryIssueCount} issue${limitedIssues.length > 1 ? 's' : ''} in ${filesSummary}${typesStr}`;
  
  // Build detailed summary lines
  const detailedLines: string[] = [];
  if (wasLimited) {
    detailedLines.push(`  ⚠ Batched: Processing ${limitedIssues.length} of ${originalCount} issues (prompt size limit)`);
  }
  detailedLines.push(`  From: ${authorsSummary}`);
  detailedLines.push(`  Files: ${files.length} (${files.map(f => f.split('/').pop()).slice(0, 5).join(', ')}${files.length > 5 ? '...' : ''})`);
  
  // Show first few issue previews (sanitize so BUGBOT/metadata never appears in logs or summaries)
  const previews = limitedIssues.slice(0, 3).map((issue, i) => {
    const firstLine = sanitizeCommentForPrompt(issue.comment.body).split('\n')[0].substring(0, 60);
    return `  ${i + 1}. ${firstLine}${issue.comment.body.length > 60 ? '...' : ''}`;
  });
  if (limitedIssues.length > 3) {
    previews.push(`  ... and ${limitedIssues.length - 3} more`);
  }

  // Add lessons section to detailed summary — header only so we don't duplicate the full list (same content is in "## Lessons Learned" below; output.log audit).
  const lessonsSection: string[] = [];
  if (lessonsLearned.length > 0) {
    const displayCount = Math.min(lessonsLearned.length, lessonCap);
    lessonsSection.push('');
    lessonsSection.push(`  ⚠ Lessons Learned (${displayCount}${lessonsLearned.length > displayCount ? `/${lessonsLearned.length}` : ''}) — see prompt for details`);
  }

  const detailedSummary = [summary, ...detailedLines, '', '  Issues:', ...previews, ...lessonsSection].join('\n');

  // Add lessons learned — technical constraints discovered from previous fix attempts.
  if (lessonsLearned.length > 0) {
    // Take only the most recent lessons (most relevant to current state)
    const capped = lessonsLearned.slice(-lessonCap);
    const skipped = lessonsLearned.length - capped.length;
    // Cycle 13 L3 / 14 L2: When file-specific lessons exist, nudge that they apply to this batch.
    const hasFileSpecificLessons = capped.some((l) => /^Fix for\s+[^\s]+(\s|-)/.test(l));

    parts.push('## Lessons Learned (from previous attempts)\n');
    if (hasFileSpecificLessons) {
      parts.push('One or more lessons below apply directly to the TARGET FILE(S) in this batch — use them to avoid repeating past failures.\n');
    }
    parts.push('These lessons were learned from prior fix attempts on these same issues. Each one represents a failed approach — account for them so you make progress instead of repeating the same mistakes:\n');
    if (skipped > 0) {
      parts.push(`_(${skipped} older entries omitted — showing ${capped.length} most recent)_\n`);
    }
    for (const lesson of capped) {
      parts.push(`- ${formatLessonForDisplay(lesson)}`);
    }
    parts.push('');
  }

  // Add PR context so the fixer knows what the PR is trying to accomplish.
  // WHY: The fixer only sees individual review comments + code snippets.
  // Without the PR title/description, it has no idea whether the PR is a
  // refactor, a new feature, or a bug fix — and may produce fixes that are
  // technically correct but semantically wrong for the PR's intent.
  //
  // WHY 500 chars: PR descriptions can be huge (templates, checklists, HTML
  // image embeds). Unbounded inclusion would blow the token budget. 500 chars
  // captures the intent without the noise.
  if (options?.prInfo && options.prInfo.title) {
    parts.push('## PR Context\n');
    parts.push(`**Title:** ${options.prInfo.title}`);
    if (options.prInfo.body) {
      const truncatedBody = options.prInfo.body.length > 500
        ? options.prInfo.body.substring(0, 500) + '...'
        : options.prInfo.body;
      parts.push(`**Description:** ${truncatedBody}`);
    }
    parts.push(`**Base branch:** ${options.prInfo.baseBranch}`);
    parts.push('\nKeep fixes aligned with this PR\'s intent.\n');
  }

  // WHY: The fixer only sees individual review comments + code snippets; showing
  // the diff summary (files/lines changed) helps it understand PR scope and make
  // targeted, contextual fixes instead of guessing what this PR is changing.
  // Prompts.log audit: for tiny batches (<=2 issues) cap diff to keep prompt size down.
  if (options?.diffStat && options.diffStat.trim()) {
    const MAX_DIFF_STAT_SINGLE_ISSUE_CHARS = 1500;
    const MAX_DIFF_STAT_TINY_BATCH_CHARS = 2500;
    const MAX_DIFF_STAT_MEDIUM_BATCH_CHARS = 5000;
    let diffStat = options.diffStat.trim();
    const issueCount = limitedIssues.length;
    const diffCap = issueCount <= 1 ? MAX_DIFF_STAT_SINGLE_ISSUE_CHARS
      : issueCount <= 2 ? MAX_DIFF_STAT_TINY_BATCH_CHARS
      : issueCount <= 5 ? MAX_DIFF_STAT_MEDIUM_BATCH_CHARS
      : MAX_DIFF_STAT_MEDIUM_BATCH_CHARS * 2;
    if (diffStat.length > diffCap) {
      // For medium+ batches, try to keep only lines for files in the batch
      const batchFiles = new Set(limitedIssues.map((i) => i.resolvedPath ?? i.comment.path));
      const relevantLines = diffStat.split('\n').filter(line =>
        [...batchFiles].some(f => line.includes(f)) || /^\s*\d+ files? changed/.test(line)
      );
      const relevantDiff = relevantLines.join('\n');
      if (relevantDiff.length > 0) {
        diffStat = relevantDiff.length <= diffCap
          ? relevantDiff + '\n... (showing only files in this batch)'
          : relevantDiff.substring(0, diffCap) + '\n... (diff truncated)';
      } else {
        diffStat = diffStat.substring(0, diffCap) + '\n... (diff truncated)';
      }
    }
    parts.push('## What this PR changes (diff summary)\n');
    parts.push('```');
    parts.push(diffStat);
    parts.push('```\n');
  }

  // High-attention files: bots have commented multiple times here; fixer should be thorough.
  const botRiskByFile = options?.botRiskByFile;
  if (botRiskByFile && botRiskByFile.size > 0) {
    const hotFiles = files.filter(f => (botRiskByFile.get(f)?.total ?? 0) >= 2);
    for (const f of hotFiles) {
      parts.push(`Bots have commented multiple times in ${f}; consider addressing similar concerns.\n`);
    }
  }

  parts.push('## Issues to Fix\n');
  // When any issue asks to delete/remove files, nudge to use <deletefile> (Cycle 13 M2).
  const mentionsDeleteOrStray = limitedIssues.some((i) => bodyMentionsDeleteOrStray(i.comment.body ?? ''));
  if (mentionsDeleteOrStray) {
    parts.push('**If the review asks to delete or remove files from the repo:** output `<deletefile path="relative/path"/>` for each file to remove. Do not just empty the file or add a comment — the file must be deleted.\n');
  }

  for (let i = 0; i < limitedIssues.length; i++) {
    const issue = limitedIssues[i];
    // Primary path: use resolvedPath when set (basename resolved from diff) so fixer sees correct file. Prompts.log audit: comment on "reporting.py" but issue was about "benchmarks/bfcl/reporting.py".
    const primaryPath = issue.resolvedPath ?? issue.comment.path;
    // Add triage labels if available
    // WHY: The fixer should know which issues are critical (need careful handling)
    // vs trivial style nits (can get quick fixes). Importance 1-2 = critical/major,
    // difficulty 1-2 = easy/simple fix.
    const triageLabel = issue.triage
      ? ` [importance:${issue.triage.importance}/5, difficulty:${issue.triage.ease}/5]`
      : '';
    parts.push(`### Issue ${i + 1}: ${primaryPath}${issue.comment.line ? `:${issue.comment.line}` : ''}${triageLabel}`);
    let basePaths = issue.allowedPaths?.length ? filterAllowedPathsForFix(issue.allowedPaths) : [primaryPath];
    const journalPath = getMigrationJournalPath(issue);
    if (journalPath && isPathAllowedForFix(journalPath) && !basePaths.includes(journalPath)) basePaths = [...basePaths, journalPath];
    const consolidatePath = getConsolidateDuplicateTargetPath(issue);
    if (consolidatePath && isPathAllowedForFix(consolidatePath) && !basePaths.includes(consolidatePath)) basePaths = [...basePaths, consolidatePath];
    const referencedFull = getReferencedFullPathFromComment(issue);
    if (referencedFull && isPathAllowedForFix(referencedFull) && !basePaths.includes(referencedFull)) basePaths = [...basePaths, referencedFull];
    const docPath = getDocumentationPathFromComment(issue);
    if (docPath && isPathAllowedForFix(docPath) && !basePaths.includes(docPath)) basePaths = [...basePaths, docPath];
    for (const sibling of getSiblingFilePathsFromComment(issue)) {
      if (!basePaths.includes(sibling)) basePaths = [...basePaths, sibling];
    }
    for (const p of getPathsToDeleteFromComment(issue)) {
      if (!basePaths.includes(p)) basePaths = [...basePaths, p];
    }
    const fileLessons = options?.perFileLessons?.get(primaryPath) ?? options?.perFileLessons?.get(issue.comment.path);
    const implPath = getImplPathForTestFileIssue(issue, fileLessons);
    let allowedPaths = implPath && isPathAllowedForFix(implPath) && !basePaths.includes(implPath) ? [...basePaths, implPath] : basePaths;
    const testPath = getTestPathForSourceFileIssue(issue, { pathExists: options?.pathExists });
    if (testPath && isPathAllowedForFix(testPath) && !allowedPaths.includes(testPath)) allowedPaths = [...allowedPaths, testPath];
    allowedPaths = filterAllowedPathsForFix(allowedPaths);
    parts.push(`**Apply fixes for this issue only in \`${allowedPaths.join('`, `')}\`** — do not change other files for this issue.`);
    // When TARGET FILE(S) has multiple files and the review mentions callers, nudge to update implementation and every call site.
    // WHY: Prompts.log audit showed the fixer updated only reporting.py while runner.py was in TARGET FILE(S); the verifier correctly rejected because print_results still called generate_report() without await/args. Explicit nudge reduces incomplete multi-file fixes.
    const body = issue.comment.body ?? '';
    if (allowedPaths.length > 1 && /\b(?:calls?|caller|await\s+\w+\.|\.(?:py|ts|js):\d+)/i.test(body)) {
      parts.push(`This issue requires changes in **all** listed files — update the implementation and every call site (e.g. \`await\` / method calls) so signatures match.`);
    }
    if (journalPath) {
      parts.push(`Drizzle's migration journal is the JSON file \`db/migrations/meta/_journal.json\`; add an entry there. Do not add SQL (e.g. INSERT INTO __journal) or table-based journal logic.`);
    }
    parts.push(`If the review mentions another file (e.g. "duplicates … in X" or "existing in X"), that file is only a reference — fix the issue in the TARGET file(s) above (e.g. remove the duplicate here and use the shared one). Do NOT edit the referenced file unless it is listed above.`);
    if (issueRequestsTests(issue)) {
      parts.push(`If the review asks for new or updated tests, you may create or modify files in \`__tests__/\` as needed.`);
    }
    if (issueRequiresRefactor(issue)) {
      parts.push(`**This issue likely requires refactoring** (e.g. removing duplication, sharing logic). You may make broader changes in this file to consolidate code — the usual "minimal only" constraint is relaxed for this issue.\n`);
    } else {
      parts.push('');
    }
    parts.push(`**Review Comment** (${issue.comment.author}):`);
    parts.push('```');
    
    // Truncate very long comments to prevent prompt overflow
    // WHY: Some automated tools generate 10k+ char comments with HTML/details
    // Keep first 2000 chars which is enough context for the fix
    // Escape ```suggestion blocks so nested ``` don't break the outer code fence (audit: prompts.log).
    const cleanBody = escapeSuggestionBlocksInComment(sanitizeCommentForPrompt(issue.comment.body));
    if (cleanBody.length > MAX_COMMENT_CHARS) {
      parts.push(cleanBody.substring(0, MAX_COMMENT_CHARS));
      parts.push('\n... (comment truncated for brevity - see PR for full text)');
    } else {
      parts.push(cleanBody);
    }
    
    parts.push('```\n');
    
    // Render merged duplicates if present
    if (issue.mergedDuplicates && issue.mergedDuplicates.length > 0) {
      parts.push(`**Also flagged by** (${issue.mergedDuplicates.length} related comment${issue.mergedDuplicates.length > 1 ? 's' : ''}):`);
      for (const dup of issue.mergedDuplicates) {
        const cleanDup = sanitizeCommentForPrompt(dup.body);
        const preview = cleanDup.length > 200
          ? cleanDup.substring(0, 200) + '...'
          : cleanDup;
        const lineInfo = dup.line !== null ? `:${dup.line}` : '';
        parts.push(`- ${dup.path}${lineInfo} (${dup.author}): "${preview}"`);
      }
      parts.push('');
    }
    
    // Current Code is critical for fix quality — fixer needs actual context to apply search/replace (audit: include whenever available).
    if (issue.codeSnippet && issue.codeSnippet !== SNIPPET_PLACEHOLDER) {
      parts.push('**Current Code:**');
      parts.push('```');
      
      const snippetLines = issue.codeSnippet.split('\n');
      if (snippetLines.length <= MAX_SNIPPET_LINES) {
        parts.push(issue.codeSnippet);
      } else {
        // WHY center on issue line: Audit showed first-500-lines truncation cut off the relevant section
        // (e.g. models array at line 169); center window on issue.comment.line so fixer sees the right code.
        const issueLine = issue.comment.line ?? 1;
        let startIdx = 0;
        const lineNumRe = /^\s*(\d+)\s*:/;
        for (let i = 0; i < snippetLines.length; i++) {
          const m = snippetLines[i]!.match(lineNumRe);
          const num = m ? parseInt(m[1]!, 10) : i + 1;
          if (num >= issueLine) {
            startIdx = Math.max(0, i - Math.floor(MAX_SNIPPET_LINES / 2));
            break;
          }
        }
        const endIdx = Math.min(snippetLines.length, startIdx + MAX_SNIPPET_LINES);
        const slice = snippetLines.slice(startIdx, endIdx).join('\n');
        parts.push(slice);
        parts.push(`\n... (${snippetLines.length - (endIdx - startIdx)} more lines omitted)`);
      }
      
      parts.push('```\n');
      // Prompts.log audit: very short or placeholder-like excerpts cause WRONG_LOCATION; tell fixer to use full file or broader section.
      if (isSnippetTooShort(issue.codeSnippet)) {
        parts.push('**Note:** The excerpt above is very short or missing; use full file content or a broader section to apply your fix.\n');
      }
    }

    if (issue.explanation) {
      parts.push(`**Analysis:** ${issue.explanation}\n`);
    }

    if ((issue.verifierFeedbackHistory?.length ?? 0) > 0 || issue.verifierContradiction) {
      const history = issue.verifierFeedbackHistory ?? [];
      if (history.length > 0) {
        parts.push('**Verifier feedback (previous rounds — do not repeat the same fix):**');
        history.forEach((msg, idx) => {
          parts.push(`  • Round ${idx + 1}: ${msg}`);
        });
        const lastInHistory = history[history.length - 1];
        if (issue.verifierContradiction && issue.verifierContradiction !== lastInHistory) {
          parts.push(`**⚠ Latest — address this:** ${issue.verifierContradiction}`);
        } else {
          parts.push('**⚠ Address the latest feedback above.**');
        }
        parts.push('');
        // Audit: full-file rewrite can perpetuate corruption from failed S/R (e.g. duplicate "Architecture" line).
        parts.push('**Note:** Previous fix attempts may have left artifacts in this file. Compare carefully with the original review comment so your fix addresses the original issue, not just the corruption.');
        parts.push('');
      } else if (issue.verifierContradiction) {
        parts.push(`**⚠ Latest — address this:** ${issue.verifierContradiction}`);
      }
      parts.push('The verifier checked the actual code and found the issue still exists. Treat the latest feedback above as the source of truth. Your fix must directly address it (e.g. add the missing code or change the cited location) so the next verification passes.');
      parts.push('If the current file content below already contains the fix (e.g. the code the verifier said was missing is now present), you may respond RESULT: ALREADY_FIXED and cite the exact lines that resolve the issue. Only do this if the evidence is unambiguous; otherwise make the requested change.');
      parts.push('If the verifier suggested a more robust or structural approach (e.g. "restructure", "use X instead", "a more robust fix would be"), prefer that over a minimal workaround — the verifier will reject fragile heuristics.');
      parts.push('Re-check the current file content at the lines the verifier cited — the code snippet in this prompt may be stale or partial; the verifier saw the actual file.\n');
    }

    // Inject file-specific lessons INLINE with each issue.
    // HISTORY: Lessons in the top-level section were 2000+ tokens away from the
    // issue they applied to. The fixer ignored "delete lines 429-506" for
    // verify/route.ts because it was out of the attention window by the time
    // it processed that issue. Putting lessons right here, next to the code
    // snippet, ensures the fixer sees them in immediate context.
    // (fileLessons already fetched at the top of this loop iteration for implPath detection)
    if (fileLessons && fileLessons.length > 0) {
      const maxInline = issues.length > 10 ? 1 : 3; // WHY: Same as lessonCap — large batch needs smaller prompt.
      const shown = fileLessons.slice(-maxInline);
      parts.push(`**⚠ File-specific lessons (from previous failed attempts on this file):**`);
      for (const lesson of shown) {
        parts.push(`- ${formatLessonForDisplay(lesson)}`);
      }
      if (fileLessons.length > maxInline) {
        parts.push(`_(${fileLessons.length - maxInline} older lessons omitted)_`);
      }
      parts.push('');
    }
  }

  parts.push('## Instructions\n');
  parts.push('1. Address each issue listed above. Each issue specifies its file — apply that issue\'s fix only in that file; do not fix an issue by editing a different file.');
  parts.push('   Exception: If an issue asks for adding or updating tests, you may create or modify files in __tests__/ as needed.');
  parts.push('2. Make targeted changes that fully address the fix — only modify lines directly related to the issue');
  parts.push('   Exception: For issues that request removing duplication or sharing logic (e.g. "duplicates X", "refactor to share"), you may refactor and consolidate code in that file as needed.');
  parts.push('3. Do NOT rewrite files, reorganize code, or make stylistic changes (except when an issue explicitly requires refactoring as above)');
  parts.push('4. Do NOT change working code that is not mentioned in the review');
  parts.push('5. Preserve existing code structure, variable names, and formatting');
  parts.push('6. If an issue is unclear, use RESULT: UNCLEAR to explain what is ambiguous instead of guessing.');
  parts.push('7. When using search/replace, copy the search text EXACTLY from the actual file content — the code snippet in the review comment may be stale');
  parts.push('8. Keep search blocks SHORT (3-10 lines) with at least one unique identifier (function name, variable, import, etc.)');
  parts.push('9. Do not output <change> blocks where <search> and <replace> are identical (no-op); they are skipped and waste verification.');
  parts.push('10. For new files use <file path="path/to/file.ts">content</file>; do not use <newfile>.');
  parts.push('');
  parts.push('## Reporting Your Outcome\n');
  parts.push('After addressing the issues, include a RESULT line for each issue (or one overall):');
  parts.push('RESULT: FIXED — <brief description of what was changed>');
  parts.push('RESULT: ALREADY_FIXED — <cite the specific code that already handles this>');
  parts.push('RESULT: NEEDS_DISCUSSION — <reasoning> (add a // Note: comment near the relevant code)');
  parts.push('RESULT: UNCLEAR — <what is ambiguous in the review instructions>');
  parts.push('RESULT: WRONG_LOCATION — <the review mentions lines X-Y but the code there is different>');
  parts.push('RESULT: CANNOT_FIX — <why this requires non-code changes>');
  parts.push('RESULT: ATTEMPTED — <what was changed> (optional: CAVEAT: <risks or uncertainties>)\n');
  parts.push('Rules:');
  parts.push('- If you make code changes, RESULT: FIXED is assumed (the line is optional).');
  parts.push('- If an issue is ALREADY FIXED, do NOT make cosmetic changes. Cite the evidence.');
  parts.push('- If instructions are UNCLEAR, explain the ambiguity instead of guessing.');
  parts.push('- For NEEDS_DISCUSSION, add ONE short code comment: // Note: <durable explanation>.');
  parts.push('  Comment must be long-term documentation: no line numbers, no commit hashes, no tool names. Example: "Note: Backoff is enforced in acquire(); explicit sleep here is redundant."');
  parts.push('- NEVER add comments (// or #) to .json files — JSON has no comment syntax and it will break parsing. For JSON issues, use RESULT: NEEDS_DISCUSSION without adding an inline comment.');
  parts.push('- Do NOT make zero changes without at least one RESULT line (or NO_CHANGES:) explaining why.');
  const fullPrompt = parts.join('\n');
  const estimatedTokens = estimateTokens(fullPrompt);
  
  // Safety check: Warn if prompt is approaching token limits
  // WHY: Anthropic has 200k token limit, we want to stay well under
  const MAX_SAFE_TOKENS = 180000; // Leave 20k buffer for model response
  if (estimatedTokens > MAX_SAFE_TOKENS) {
    console.warn(`⚠ Warning: Fix prompt is very large (${estimatedTokens.toLocaleString()} tokens)`);
    console.warn(`  This may fail with some LLM providers (200k token limit)`);
    console.warn(`  Consider using --max-fix-iterations to process fewer issues per batch`);
  }

  return {
    prompt: fullPrompt,
    summary,
    detailedSummary,
    lessonsIncluded: Math.min(lessonsLearned.length, lessonCap),
    issues: limitedIssues,  // Return only the issues included in the prompt
  };
}

export function buildVerificationPrompt(
  commentBody: string,
  filePath: string,
  diff: string
): string {
  const cleanComment = sanitizeCommentForPrompt(commentBody);
  return `Given this code review comment:
---
Comment: ${cleanComment}
File: ${filePath}
---

And this code change (diff):
---
${diff}
---

Does this change adequately address the concern raised in the comment?

Analyze carefully:
1. Does the change target the right location/issue?
2. Does it actually fix the problem described?
3. Does it introduce any new issues?

Respond with exactly one of these formats:
YES: <brief explanation of how the change addresses the issue>
NO: <brief explanation of what's still missing or wrong>`;
}
