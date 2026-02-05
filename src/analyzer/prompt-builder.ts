import type { UnresolvedIssue, FixPrompt } from './types.js';
import { formatLessonForDisplay } from '../state/lessons.js';

/**
 * Estimate token count for a string.
 * WHY: Anthropic has 200k token limit. We need to detect when prompts are too large.
 * Rough estimate: 1 token ≈ 4 characters (conservative for English text)
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Maximum number of issues to include in a single fix prompt.
 * WHY: Large prompts (100+ issues) can exceed LLM token limits (200k).
 * With truncation (2k per comment + 500 lines per snippet), 50 issues ≈ 100k chars ≈ 25k tokens.
 * This leaves room for lessons and boilerplate while staying under limits.
 */
const MAX_ISSUES_PER_PROMPT = 50;

export function buildFixPrompt(issues: UnresolvedIssue[], lessonsLearned: string[]): FixPrompt {
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

  // Limit issues per prompt to prevent token overflow
  // WHY: 124 issues at once = 202k tokens which exceeds Anthropic's 200k limit
  const originalCount = issues.length;
  const limitedIssues = issues.slice(0, MAX_ISSUES_PER_PROMPT);
  const wasLimited = originalCount > MAX_ISSUES_PER_PROMPT;

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

  // Add lessons learned section to detailed summary
  const lessonsSection: string[] = [];
  if (lessonsLearned.length > 0) {
    lessonsSection.push('');
    lessonsSection.push(`  ⚠ Previous Attempts (${lessonsLearned.length}):`);
    // Show all lessons - these are critical for debugging progress
    for (const lesson of lessonsLearned) {
      // Strip redundant prefix, show just the useful content
      const displayLesson = formatLessonForDisplay(lesson);
      const wrapped = displayLesson.length > 80 
        ? displayLesson.substring(0, 77) + '...'
        : displayLesson;
      lessonsSection.push(`    • ${wrapped}`);
    }
  }

  const detailedSummary = [summary, ...detailedLines, '', '  Issues:', ...previews, ...lessonsSection].join('\n');

  // Add lessons learned to prevent flip-flopping
  if (lessonsLearned.length > 0) {
    parts.push('## Previous Attempts (DO NOT REPEAT THESE MISTAKES)\n');
    parts.push('The following approaches have already been tried and FAILED. Do NOT repeat them:\n');
    for (const lesson of lessonsLearned) {
      // Strip redundant prefix, show just the useful content
      parts.push(`- ${formatLessonForDisplay(lesson)}`);
    }
    parts.push('');
  }

  parts.push('## Issues to Fix\n');

  for (let i = 0; i < limitedIssues.length; i++) {
    const issue = limitedIssues[i];
    parts.push(`### Issue ${i + 1}: ${issue.comment.path}${issue.comment.line ? `:${issue.comment.line}` : ''}\n`);
    parts.push(`**Review Comment** (${issue.comment.author}):`);
    parts.push('```');
    
    // Truncate very long comments to prevent prompt overflow
    // WHY: Some automated tools generate 10k+ char comments with HTML/details
    // Keep first 2000 chars which is enough context for the fix
    const MAX_COMMENT_CHARS = 2000;
    if (issue.comment.body.length > MAX_COMMENT_CHARS) {
      parts.push(issue.comment.body.substring(0, MAX_COMMENT_CHARS));
      parts.push('\n... (comment truncated for brevity - see PR for full text)');
    } else {
      parts.push(issue.comment.body);
    }
    
    parts.push('```\n');
    
    if (issue.codeSnippet) {
      parts.push('**Current Code:**');
      parts.push('```');
      
      // Truncate very large code snippets to prevent prompt overflow
      // WHY: Sometimes entire files are included (10k+ lines)
      // Keep first 500 lines which is usually more than enough for context
      const MAX_SNIPPET_LINES = 500;
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
  }

  parts.push('## Instructions\n');
  parts.push('1. Address each issue listed above');
  parts.push('2. Make MINIMAL, SURGICAL changes - only modify lines directly related to the fix');
  parts.push('3. Do NOT rewrite files, reorganize code, or make stylistic changes');
  parts.push('4. Do NOT change working code that is not mentioned in the review');
  parts.push('5. Preserve existing code structure, variable names, and formatting');
  parts.push('6. If an issue is unclear, make the smallest reasonable fix');
  parts.push('');
  parts.push('## CRITICAL: If You Make Zero Changes\n');
  parts.push('If you decide NOT to make any file changes, you MUST explain why in your output.');
  parts.push('Output a line starting with "NO_CHANGES:" followed by a detailed explanation.\n');
  parts.push('Valid reasons include:');
  parts.push('- Issue is already fixed (cite specific code)');
  parts.push('- Cannot determine correct fix (explain what is unclear)');
  parts.push('- Issue is not actually a problem (explain why)');
  parts.push('- Code already handles this correctly (cite specific implementation)\n');
  parts.push('Example:');
  parts.push('NO_CHANGES: Issue 1 is already fixed - Line 45 has null check: if (value === null) return;\n');
  parts.push('DO NOT make zero changes without this explanation. The system requires documentation of why no changes were made.');

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
