import type { UnresolvedIssue, FixPrompt } from './types.js';
import { formatLessonForDisplay } from '../state/lessons-normalize.js';
import { MAX_ISSUES_PER_PROMPT, MIN_ISSUES_PER_PROMPT, MAX_COMMENT_CHARS, MAX_SNIPPET_LINES } from '../constants.js';

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

  return s.trim();
}

/**
 * Estimate token count for a string.
 * WHY: Anthropic has 200k token limit. We need to detect when prompts are too large.
 * Rough estimate: 1 token ≈ 4 characters (conservative for English text)
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
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

  // Cap lessons to prevent prompt bloat (73+ lessons = prompt poisoning)
  const MAX_LESSONS = 15;

  // Limit issues per prompt to prevent token overflow
  // WHY: 124 issues at once = 202k tokens which exceeds Anthropic's 200k limit
  // The effective limit may be reduced by adaptive batching when consecutive iterations fail.
  const effectiveMax = options?.maxIssues ?? MAX_ISSUES_PER_PROMPT;
  const originalCount = issues.length;
  const limitedIssues = issues.slice(0, effectiveMax);
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
  const fileSet = new Set(limitedIssues.map(i => i.comment.path));
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
  
  // Show first few issue previews
  const previews = limitedIssues.slice(0, 3).map((issue, i) => {
    const preview = issue.comment.body.split('\n')[0].substring(0, 60);
    return `  ${i + 1}. ${preview}${issue.comment.body.length > 60 ? '...' : ''}`;
  });
  if (limitedIssues.length > 3) {
    previews.push(`  ... and ${limitedIssues.length - 3} more`);
  }

  // Add lessons section to detailed summary (capped to avoid log noise)
  const lessonsSection: string[] = [];
  if (lessonsLearned.length > 0) {
    const displayCount = Math.min(lessonsLearned.length, MAX_LESSONS);
    const displayLessons = lessonsLearned.slice(-displayCount);
    lessonsSection.push('');
    lessonsSection.push(`  ⚠ Lessons Learned (${displayCount}${lessonsLearned.length > displayCount ? `/${lessonsLearned.length}` : ''}):`);
    for (const lesson of displayLessons) {
      const displayLesson = formatLessonForDisplay(lesson);
      const wrapped = displayLesson.length > 80 
        ? displayLesson.substring(0, 77) + '...'
        : displayLesson;
      lessonsSection.push(`    • ${wrapped}`);
    }
  }

  const detailedSummary = [summary, ...detailedLines, '', '  Issues:', ...previews, ...lessonsSection].join('\n');

  // Add lessons learned — technical constraints discovered from previous fix attempts.
  if (lessonsLearned.length > 0) {
    // Take only the most recent lessons (most relevant to current state)
    const capped = lessonsLearned.slice(-MAX_LESSONS);
    const skipped = lessonsLearned.length - capped.length;

    parts.push('## Lessons Learned (from previous attempts)\n');
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
  // minimal, contextual fixes instead of guessing what this PR is changing.
  if (options?.diffStat && options.diffStat.trim()) {
    parts.push('## What this PR changes (diff summary)\n');
    parts.push('```');
    parts.push(options.diffStat.trim());
    parts.push('```\n');
  }

  parts.push('## Issues to Fix\n');

  for (let i = 0; i < limitedIssues.length; i++) {
    const issue = limitedIssues[i];
    // Add triage labels if available
    // WHY: The fixer should know which issues are critical (need careful handling)
    // vs trivial style nits (can get quick fixes). Importance 1-2 = critical/major,
    // difficulty 1-2 = easy/simple fix.
    const triageLabel = issue.triage
      ? ` [importance:${issue.triage.importance}/5, difficulty:${issue.triage.ease}/5]`
      : '';
    parts.push(`### Issue ${i + 1}: ${issue.comment.path}${issue.comment.line ? `:${issue.comment.line}` : ''}${triageLabel}\n`);
    parts.push(`**Review Comment** (${issue.comment.author}):`);
    parts.push('```');
    
    // Truncate very long comments to prevent prompt overflow
    // WHY: Some automated tools generate 10k+ char comments with HTML/details
    // Keep first 2000 chars which is enough context for the fix
    
    const cleanBody = sanitizeCommentForPrompt(issue.comment.body);
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
    
    if (issue.codeSnippet) {
      parts.push('**Current Code:**');
      parts.push('```');
      
      // Truncate very large code snippets to prevent prompt overflow
      // WHY: Sometimes entire files are included (10k+ lines)
      // Keep first 500 lines which is usually more than enough for context
      
      const snippetLines = issue.codeSnippet.split('\n');
      if (snippetLines.length > MAX_SNIPPET_LINES) {
        parts.push(snippetLines.slice(0, MAX_SNIPPET_LINES).join('\n'));
        parts.push(`\n... (${snippetLines.length - MAX_SNIPPET_LINES} more lines omitted)`);
      } else {
        parts.push(issue.codeSnippet);
      }
      
      parts.push('```\n');
    }

    if (issue.explanation) {
      parts.push(`**Analysis:** ${issue.explanation}\n`);
    }

    // Inject file-specific lessons INLINE with each issue.
    // HISTORY: Lessons in the top-level section were 2000+ tokens away from the
    // issue they applied to. The fixer ignored "delete lines 429-506" for
    // verify/route.ts because it was out of the attention window by the time
    // it processed that issue. Putting lessons right here, next to the code
    // snippet, ensures the fixer sees them in immediate context.
    const fileLessons = options?.perFileLessons?.get(issue.comment.path);
    if (fileLessons && fileLessons.length > 0) {
      const maxInline = 3; // Keep inline section brief — top-level has the full list
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
  parts.push('1. Address each issue listed above');
  parts.push('2. Make MINIMAL, SURGICAL changes — only modify lines directly related to the fix');
  parts.push('3. Do NOT rewrite files, reorganize code, or make stylistic changes');
  parts.push('4. Do NOT change working code that is not mentioned in the review');
  parts.push('5. Preserve existing code structure, variable names, and formatting');
  parts.push('6. If an issue is unclear, use RESULT: UNCLEAR to explain what is ambiguous instead of guessing.');
  parts.push('7. When using search/replace, copy the search text EXACTLY from the actual file content — the code snippet in the review comment may be stale');
  parts.push('8. Keep search blocks SHORT (3-10 lines) with at least one unique identifier (function name, variable, import, etc.)');
  parts.push('');
  parts.push('## Reporting Your Outcome\n');
  parts.push('After addressing the issues, include a RESULT line for each issue (or one overall):');
  parts.push('RESULT: FIXED — <brief description of what was changed>');
  parts.push('RESULT: ALREADY_FIXED — <cite the specific code that already handles this>');
  parts.push('RESULT: NEEDS_DISCUSSION — <reasoning> (add a // REVIEW: comment near the relevant line)');
  parts.push('RESULT: UNCLEAR — <what is ambiguous in the review instructions>');
  parts.push('RESULT: WRONG_LOCATION — <the review mentions lines X-Y but the code there is different>');
  parts.push('RESULT: CANNOT_FIX — <why this requires non-code changes>');
  parts.push('RESULT: ATTEMPTED — <what was changed> (optional: CAVEAT: <risks or uncertainties>)\n');
  parts.push('Rules:');
  parts.push('- If you make code changes, RESULT: FIXED is assumed (the line is optional).');
  parts.push('- If an issue is ALREADY FIXED, do NOT make cosmetic changes. Cite the evidence.');
  parts.push('- If instructions are UNCLEAR, explain the ambiguity instead of guessing.');
  parts.push('- For NEEDS_DISCUSSION, add a code comment: // REVIEW: <your reasoning>');
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
    lessonsIncluded: lessonsLearned.length,
    issues: limitedIssues,  // Return only the issues included in the prompt
  };
}

export function buildVerificationPrompt(
  commentBody: string,
  filePath: string,
  diff: string
): string {
  return `Given this code review comment:
---
Comment: ${commentBody}
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
