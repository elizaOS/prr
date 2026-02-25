/**
 * Commit message formatting utilities
 */

/**
 * Generate a concise first line for commit message.
 * Format: scope: description
 */
export function generateCommitFirstLine(
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
 * Prefers specific issue titles (e.g. "### Fix X") then pattern-based fallbacks.
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

  // Prefer first line of first comment when it looks like a specific fix (### Title or Fix/Add/Remove...)
  const firstComment = fixedIssues[0]!.comment;
  const firstLine = firstComment.split(/\n/)[0]?.trim() ?? '';
  const stripped = stripMarkdownForCommit(firstLine)
    .replace(/^#+\s*/, '')  // drop ### prefix from bot titles
    .trim();
  if (stripped.length >= 12 && stripped.length <= 72 && !/^https?:\/\//.test(stripped)) {
    const looksLikeFix = /^(fix|add|remove|improve|address|correct|prevent|handle|ensure)\s+/i.test(stripped) ||
      /^(SIWE|credit|cleanup|race|time-window|stale|export|fallback)/i.test(stripped);
    if (looksLikeFix || fixedIssues.length === 1) {
      return stripped;
    }
  }

  // Combine all comments and look for specific patterns first (more specific before generic)
  const allText = fixedIssues.map(i => i.comment.toLowerCase()).join(' ');

  const patterns: Array<{ regex: RegExp; desc: string }> = [
    { regex: /time-window|notbefore|expirationtime|chronological/i, desc: 'fix SIWE time-window checks' },
    { regex: /stale\s+credit|credit\s+balance|pre-credit/i, desc: 'fix stale credit balance in signup response' },
    { regex: /cleanup.*catch|userCreated.*try.*catch|block\s+scope/i, desc: 'fix cleanup variable scope in signup' },
    { regex: /race\s+condition\s+recovery|account\s+active\s+checks/i, desc: 'add account active checks in race recovery' },
    { regex: /organizationId\s+fallback|organization_id\s+\?\?/i, desc: 'consistent organizationId fallback in handlers' },
    { regex: /SyncOptions\s+export|export.*SyncOptions/i, desc: 'restore SyncOptions export' },
    { regex: /retry\s+cleanup|orphan.*organization/i, desc: 'add retry cleanup for orphaned orgs' },
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
  if (nounMatch && nounMatch[1]!.length < 30) {
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
