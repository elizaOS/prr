import type { UnresolvedIssue, FixPrompt } from './types.js';
import { formatLessonForDisplay } from '../state/lessons.js';

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

  const parts: string[] = [];

  parts.push('# Code Review Issues to Fix\n');
  parts.push('Please address the following code review issues.\n');

  // Build a short summary for console output
  const fileSet = new Set(issues.map(i => i.comment.path));
  const files = Array.from(fileSet);
  const filesSummary = files.length <= 3 
    ? files.map(f => f.split('/').pop()).join(', ')  // Just filename
    : `${files.slice(0, 2).map(f => f.split('/').pop()).join(', ')} +${files.length - 2} more`;
  
  const authors = Array.from(new Set(issues.map(i => i.comment.author)));
  const authorsSummary = authors.length <= 2 
    ? authors.join(', ') 
    : `${authors.slice(0, 2).join(', ')} +${authors.length - 2} more`;

  // Group issues by type of comment (look for keywords)
  const issueTypes: string[] = [];
  const bodies = issues.map(i => i.comment.body.toLowerCase());
  if (bodies.some(b => b.includes('error') || b.includes('bug') || b.includes('fix'))) issueTypes.push('bugs');
  if (bodies.some(b => b.includes('type') || b.includes('typescript'))) issueTypes.push('types');
  if (bodies.some(b => b.includes('test'))) issueTypes.push('tests');
  if (bodies.some(b => b.includes('security') || b.includes('auth'))) issueTypes.push('security');
  if (bodies.some(b => b.includes('performance') || b.includes('optimize'))) issueTypes.push('perf');
  if (bodies.some(b => b.includes('style') || b.includes('format') || b.includes('lint'))) issueTypes.push('style');
  
  const typesStr = issueTypes.length > 0 ? ` (${issueTypes.join(', ')})` : '';

  const summary = `Fixing ${issues.length} issue${issues.length > 1 ? 's' : ''} in ${filesSummary}${typesStr}`;
  
  // Build detailed summary lines
  const detailedLines: string[] = [];
  detailedLines.push(`  From: ${authorsSummary}`);
  detailedLines.push(`  Files: ${files.length} (${files.map(f => f.split('/').pop()).slice(0, 5).join(', ')}${files.length > 5 ? '...' : ''})`);
  
  // Show first few issue previews
  const previews = issues.slice(0, 3).map((issue, i) => {
    const preview = issue.comment.body.split('\n')[0].substring(0, 60);
    return `  ${i + 1}. ${preview}${issue.comment.body.length > 60 ? '...' : ''}`;
  });
  if (issues.length > 3) {
    previews.push(`  ... and ${issues.length - 3} more`);
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

  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    parts.push(`### Issue ${i + 1}: ${issue.comment.path}${issue.comment.line ? `:${issue.comment.line}` : ''}\n`);
    parts.push(`**Review Comment** (${issue.comment.author}):`);
    parts.push('```');
    parts.push(issue.comment.body);
    parts.push('```\n');
    
    if (issue.codeSnippet) {
      parts.push('**Current Code:**');
      parts.push('```');
      parts.push(issue.codeSnippet);
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

  return {
    prompt: parts.join('\n'),
    summary,
    detailedSummary,
    lessonsIncluded: lessonsLearned.length,
    issues,
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
