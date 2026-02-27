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
  
  // Count occurrences of each directory segment (exclude final path segment/leaf — filenames like package.json are not scope candidates)
  const scopeCounts = new Map<string, number>();
  
  for (const path of filePaths) {
    const segments = path.split('/').filter(s => s && s !== '.' && s !== '..');
    const dirSegments = segments.length > 1 ? segments.slice(0, -1) : [];
    
    // Skip top-level segments like 'src', 'lib', etc.
    const meaningfulSegments = dirSegments.filter(s => 
      !['src', 'lib', 'dist', 'build', 'test', 'tests'].includes(s.toLowerCase())
    );
    
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
 * Build a file/scope-based fallback description (used when no pattern or title matches).
 */
function fileBasedFallback(filePaths: string[]): string {
  if (filePaths.length === 0) return 'improve code quality';
  const scope = determineScope(filePaths);
  const baseNames = filePaths
    .map((p) => p.split('/').pop()?.replace(/\.[^.]+$/, '') || 'file')
    .filter(Boolean);
  const uniq = [...new Set(baseNames)];
  if (scope !== 'misc') return `fix issues in ${scope}`;
  if (uniq.length === 1) return `fix issues in ${uniq[0]}`;
  if (uniq.length === 2) return `fix issues in ${uniq[0]}, ${uniq[1]}`;
  return `fix issues across ${uniq.length} files`;
}

/**
 * Extract a description from review comments.
 * Prefers specific issue titles (e.g. "### Fix X") then pattern-based fallbacks.
 */
function extractDescription(
  fixedIssues: Array<{ filePath: string; comment: string }>,
  filePaths: string[]
): string {
  const fileBasedDesc = fileBasedFallback(filePaths);

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

  // allText is lowercased, so /i flag is redundant
  const patterns: Array<{ regex: RegExp; desc: string }> = [
    { regex: /time-window|notbefore|expirationtime|chronological/, desc: 'fix SIWE time-window checks' },
    { regex: /stale\s+credit|credit\s+balance|pre-credit/, desc: 'fix stale credit balance in signup response' },
    { regex: /cleanup.*catch|usercreated.*try.*catch|block\s+scope/, desc: 'fix cleanup variable scope in signup' },
    { regex: /race\s+condition\s+recovery|account\s+active\s+checks/, desc: 'add account active checks in race recovery' },
    { regex: /organizationid\s+fallback|organization_id\s+\?\?/, desc: 'consistent organizationId fallback in handlers' },
    { regex: /syncoptions\s+export|export.*syncoptions/, desc: 'restore SyncOptions export' },
    { regex: /retry\s+cleanup|orphan.*organization/, desc: 'add retry cleanup for orphaned orgs' },
    { regex: /add(ing)?\s+(uuid\s+)?validation/, desc: 'add validation' },
    { regex: /add(ing)?\s+error\s+handling/, desc: 'add error handling' },
    { regex: /add(ing)?\s+null\s+check/, desc: 'add null checks' },
    { regex: /add(ing)?\s+auth(entication|orization)/, desc: 'add auth checks' },
    { regex: /missing\s+(type|return|validation)/, desc: 'add missing types' },
    { regex: /remove\s+(unused|dead)/, desc: 'remove unused code' },
    { regex: /duplicate/, desc: 'consolidate duplicate logic' },
    { regex: /extract\s+(to|into)/, desc: 'extract shared code' },
    { regex: /simplif(y|ied)/, desc: 'simplify implementation' },
    { regex: /refactor/, desc: 'refactor for clarity' },
    { regex: /performance|optimi[zs]/, desc: 'improve performance' },
    { regex: /security|vulnerab/, desc: 'fix security issue' },
    { regex: /race\s+condition/, desc: 'fix race condition' },
    { regex: /memory\s+leak/, desc: 'fix memory leak' },
    { regex: /exception|error\s+handling/, desc: 'improve error handling' },
    { regex: /type\s+safety|typescript|:\s*string\s*\||:\s*number|add(ing)?\s+type\s+(safety|check)/, desc: 'add type safety' },
    { regex: /test\s+cover|unit\s+test|mock|jest|vitest/, desc: 'add or fix tests' },
    { regex: /lint|eslint|formatting|prettier/, desc: 'fix lint or formatting' },
    { regex: /import\s+path|missing\s+import|wrong\s+import/, desc: 'fix imports' },
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
