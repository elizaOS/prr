/**
 * Commit message formatting utilities
 */

/**
 * Generate a concise first line for commit message.
 * Format: scope: description
 */
function generateCommitFirstLine(
  fixedIssues: Array<{ filePath: string; comment: string }>,
  filePaths: string[]
): string {
  const scope = determineScope(filePaths);
  const desc = extractDescription(fixedIssues, filePaths);
  return `${scope}: ${desc}`;
}

/**
 * Determine the scope (area of codebase) from file paths.
 * Examples: "auth", "api", "ui", "core"
 */
function determineScope(filePaths: string[]): string {
  if (filePaths.length === 0) return 'misc';
  
  // Count occurrences of each directory segment
  const scopeCounts = new Map<string, number>();
  
  for (const path of filePaths) {
    const segments = path.split('/').filter(s => s && s !== '.' && s !== '..');
    
    // Skip top-level segments like 'src', 'lib', etc.
    const meaningfulSegments = segments.filter(s => 
      !['src', 'lib', 'dist', 'build', 'test', 'tests'].includes(s.toLowerCase())
    );
    
    // Use the first meaningful segment as the scope
    if (meaningfulSegments.length > 0) {
      const scope = meaningfulSegments[0];
      scopeCounts.set(scope, (scopeCounts.get(scope) || 0) + 1);
    }
  }
  
  // Find the most common scope
  let bestScope = 'misc';
  let maxCount = 0;
  
  for (const [scope, count] of scopeCounts) {
    if (count > maxCount) {
      maxCount = count;
      bestScope = scope;
    }
  }
  
  return bestScope;
}

/**
 * Extract a description from review comments.
 * Looks for action keywords and nouns.
 */
function extractDescription(
  fixedIssues: Array<{ filePath: string; comment: string }>,
  filePaths: string[]
): string {
  // Fallback description based on files
  const fileBasedDesc = filePaths.length > 0
    ? `update ${filePaths[0].split('/').pop()?.replace(/\.[^.]+$/, '') || 'code'}`
    : 'improve code quality';
  
  if (fixedIssues.length === 0) {
    return fileBasedDesc;
  }

  // Single issue: use first line of comment as description when it's a short, readable sentence
  if (fixedIssues.length === 1) {
    const firstLine = fixedIssues[0]!.comment.split(/\n/)[0]?.trim() ?? '';
    const stripped = stripMarkdownForCommit(firstLine);
    if (stripped.length >= 10 && stripped.length <= 72 && !/^https?:\/\//.test(stripped)) {
      return stripped;
    }
  }

  // Combine all comments and look for key patterns
  const allText = fixedIssues.map(i => i.comment.toLowerCase()).join(' ');
  
  // Common improvement patterns to look for
  const patterns: Array<{ regex: RegExp; desc: string }> = [
    { regex: /add(ing)?\s+(uuid\s+)?validation/i, desc: 'add validation' },
    { regex: /add(ing)?\s+error\s+handling/i, desc: 'add error handling' },
    { regex: /add(ing)?\s+type\s+(safety|check)/i, desc: 'add type safety' },
    { regex: /add(ing)?\s+null\s+check/i, desc: 'add null checks' },
    { regex: /add(ing)?\s+auth(entication|orization)/i, desc: 'add auth checks' },
    { regex: /missing\s+(type|return|validation)/i, desc: 'add missing types' },
    { regex: /remove\s+(unused|dead)/i, desc: 'remove unused code' },
    { regex: /duplicate/i, desc: 'remove duplicate code' },
    { regex: /extract\s+(to|into)/i, desc: 'extract shared code' },
    { regex: /simplif(y|ied)/i, desc: 'simplify implementation' },
    { regex: /refactor/i, desc: 'refactor for clarity' },
    { regex: /performance|optimi[zs]/i, desc: 'improve performance' },
    { regex: /security|vulnerab/i, desc: 'fix security issue' },
    { regex: /race\s+condition/i, desc: 'fix race condition' },
    { regex: /memory\s+leak/i, desc: 'fix memory leak' },
    { regex: /exception|error\s+handling/i, desc: 'improve error handling' },
  ];
  
  for (const { regex, desc } of patterns) {
    if (regex.test(allText)) {
      return desc;
    }
  }
  
  // Try to extract specific noun phrases
  const nounMatch = allText.match(/(?:add|fix|improve|update|handle)\s+(\w+(?:\s+\w+)?)/);
  if (nounMatch && nounMatch[1].length < 30) {
    return `${allText.includes('fix') ? 'fix' : 'improve'} ${nounMatch[1]}`;
  }
  
  return fileBasedDesc;
}

/**
 * Strip markdown/HTML formatting from text for use in commit messages
 */
export function stripMarkdownForCommit(text: string): string {
  return text
    // Remove HTML tags
    .replace(/<[^>]+>/g, '')
    // Remove markdown emphasis (_text_, *text*, **text**, ~~text~~)
    .replace(/[_*~]{1,2}([^_*~]+)[_*~]{1,2}/g, '$1')
    // Remove markdown links [text](url) -> text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    // Remove common review comment prefixes/emoji patterns
    // NOTE: Using alternation instead of character class because emojis like ⚠️ have combining characters
    .replace(/^(?:⚠️|🔴|🟡|🟢|✅|❌|💡|📝|🐛)+\s*/gu, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildCommitMessage(
  issuesFixed: Array<{ filePath: string; comment: string }>,
  lessonsLearned: string[]
): string {
  // Generate a meaningful first line
  const firstLine = generateCommitFirstLine(issuesFixed, issuesFixed.map(i => i.filePath));
  const lines: string[] = [firstLine, ''];

  if (issuesFixed.length > 0) {
    lines.push('Changes:');
    for (const issue of issuesFixed) {
      const fileName = issue.filePath.split('/').pop() || issue.filePath;
      // Truncate long comments for commit body
      const truncatedComment = issue.comment.length > 80 
        ? issue.comment.slice(0, 77) + '...' 
        : issue.comment;
      lines.push(`- ${fileName}: ${truncatedComment}`);
    }
    lines.push('');
  }

  if (lessonsLearned.length > 0) {
    lines.push('Notes:');
    for (const lesson of lessonsLearned) {
      lines.push(`- ${lesson}`);
    }
  }

  return lines.join('\n');
}
