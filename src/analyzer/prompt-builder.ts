import type { UnresolvedIssue, FixPrompt } from './types.js';

export function buildFixPrompt(issues: UnresolvedIssue[], lessonsLearned: string[]): FixPrompt {
  const parts: string[] = [];

  parts.push('# Code Review Issues to Fix\n');
  parts.push('Please address the following code review issues.\n');

  // Add lessons learned to prevent flip-flopping
  if (lessonsLearned.length > 0) {
    parts.push('## Previous Attempts (DO NOT REPEAT THESE MISTAKES)\n');
    for (const lesson of lessonsLearned) {
      parts.push(`- ${lesson}`);
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
  parts.push('2. Make minimal, targeted changes');
  parts.push('3. Do not introduce new issues or change unrelated code');
  parts.push('4. Ensure the code still compiles and passes tests');
  parts.push('5. If an issue cannot be fixed without breaking changes, explain why in a comment');

  return {
    prompt: parts.join('\n'),
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
