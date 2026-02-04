import type { SimpleGit } from 'simple-git';
import { spawn, execSync, execFileSync } from 'child_process';
import { debug } from '../logger.js';

export interface CommitResult {
  hash: string;
  message: string;
  filesChanged: number;
}

export async function stageAll(git: SimpleGit): Promise<void> {
  await git.add('-A');
}

export async function squashCommit(
  git: SimpleGit,
  message: string,
  body?: string
): Promise<CommitResult> {
  // Stage all changes
  await stageAll(git);

  // Build commit message
  const fullMessage = body ? `${message}\n\n${body}` : message;

  // Commit
  const result = await git.commit(fullMessage);

  return {
    hash: result.commit,
    message,
    filesChanged: result.summary.changes,
  };
}

/**
 * Result of a push attempt, indicating whether it was rejected due to being behind.
 */
export interface PushResult {
  success: boolean;
  rejected?: boolean;  // True if push was rejected because remote has newer commits
  error?: string;
}

/**
 * Push changes to remote with timeout and signal handling.
 * 
 * WHY spawn instead of simple-git: simple-git's promises can't be cancelled,
 * and the underlying git process keeps running even after timeout. Using
 * spawn directly lets us SIGKILL the process on timeout or Ctrl+C.
 * 
 * WHY 30s timeout (reduced from 60s): Push should be fast. If it takes longer,
 * something is wrong (auth prompt, network). 30s is still generous.
 * 
 * Returns PushResult instead of throwing for rejected pushes, allowing caller
 * to handle pull-and-retry logic.
 */
export async function push(git: SimpleGit, branch: string, force = false, githubToken?: string): Promise<PushResult> {
  const PUSH_TIMEOUT_MS = 30_000; // 30 seconds (reduced from 60)
  const redactAuth = (text: string) => text.replace(/https:\/\/[^@\s]+@/g, 'https://***@');
  
  // Get the workdir from the git instance
  // WHY multiple fallbacks: simple-git internal _baseDir may be undefined in some versions
  // Use git rev-parse as the most reliable source
  let workdir: string;
  try {
    // Most reliable: ask git itself for the repo root
    workdir = (await git.revparse(['--show-toplevel'])).trim();
  } catch {
    // Fallback to internal property or cwd
    workdir = (git as any)._baseDir || process.cwd();
    debug('Using fallback workdir', { workdir, method: (git as any)._baseDir ? '_baseDir' : 'cwd' });
  }
  
  // Check if remote URL has token, inject if missing
  // WHY: Token may be stripped or repo cloned without it
  let originalRemoteUrl: string | null = null;
  let updatedRemote = false;
  const restoreRemote = () => {
    if (!updatedRemote || !originalRemoteUrl) return;
    try {
      execFileSync('git', ['remote', 'set-url', 'origin', originalRemoteUrl], { cwd: workdir });
    } catch (e) {
      debug('Failed to restore remote URL', { error: String(e) });
    } finally {
      updatedRemote = false;
    }
  };
  try {
    const remoteUrl = execSync('git remote get-url origin', { cwd: workdir, encoding: 'utf8' }).trim();
    originalRemoteUrl = remoteUrl;
    const hasTokenInUrl = remoteUrl.includes('@') && remoteUrl.startsWith('https://');
    
    if (!hasTokenInUrl && githubToken && remoteUrl.startsWith('https://')) {
      // Inject token into URL
      const authUrl = remoteUrl.replace('https://', `https://${githubToken}@`);
      execFileSync('git', ['remote', 'set-url', 'origin', authUrl], { cwd: workdir });
      updatedRemote = true;
      debug('Injected token into remote URL for push');
    } else if (!hasTokenInUrl && !githubToken) {
      debug('WARNING: Remote URL does not contain token and no token provided - push may fail');
    } else {
      debug('Pre-push check', { hasTokenInUrl });
    }
  } catch (e) {
    debug('Could not check/set remote URL', { error: String(e) });
  }
  
  const args = ['push', 'origin', branch];
  if (force) args.push('--force');
  
  const fullCommand = `git ${args.join(' ')}`;
  debug('Starting git push', { command: fullCommand, workdir });
  
  return new Promise((resolve) => {
    const gitProcess = spawn('git', args, {
      cwd: workdir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    
    let stdout = '';
    let stderr = '';
    let killed = false;
    
    // Log output as it comes in (git push progress goes to stderr)
    gitProcess.stdout?.on('data', (data) => { 
      stdout += data.toString(); 
      debug('git push stdout', redactAuth(data.toString().trim()));
    });
    gitProcess.stderr?.on('data', (data) => { 
      stderr += data.toString();
      // Show progress (git push writes progress to stderr)
      const line = redactAuth(data.toString().trim());
      if (line && !line.includes('Username') && !line.includes('Password')) {
        debug('git push progress', line);
      }
    });
    
    // Timeout - kill the process
    const timeout = setTimeout(() => {
      killed = true;
      gitProcess.kill('SIGKILL');
      restoreRemote();
      // Include the command in error for debugging
      const errMsg = [
        `Push timed out after 30 seconds.`,
        `Command: ${fullCommand}`,
        `Workdir: ${workdir}`,
        `This usually means:`,
        `  - Network issue (check connectivity)`,
        `  - Auth issue (token missing/expired)`,
        `  - Git waiting for interactive input`,
        stderr ? `stderr: ${redactAuth(stderr)}` : '',
      ].filter(Boolean).join('\n');
      resolve({ success: false, error: errMsg });
    }, PUSH_TIMEOUT_MS);
    
    // Handle Ctrl+C - kill the git process too
    const sigintHandler = () => {
      killed = true;
      gitProcess.kill('SIGKILL');
      restoreRemote();
      clearTimeout(timeout);
      process.removeListener('SIGINT', sigintHandler);
    };
    process.on('SIGINT', sigintHandler);
    
    gitProcess.on('close', (code) => {
      clearTimeout(timeout);
      process.removeListener('SIGINT', sigintHandler);
      restoreRemote();
      
      if (killed) return; // Already handled by timeout/sigint
      
      if (code === 0) {
        debug('Git push completed', { branch });
        resolve({ success: true });
      } else {
        // Check if push was rejected due to being behind remote
        const isRejected = stderr.includes('rejected') && 
          (stderr.includes('fetch first') || stderr.includes('non-fast-forward'));
        
        if (isRejected) {
          debug('Push rejected - remote has newer commits', { stderr: redactAuth(stderr) });
          resolve({ 
            success: false, 
            rejected: true,
            error: 'Push rejected: remote has newer commits. Need to pull first.',
          });
        } else {
          resolve({ 
            success: false,
            error: `Git push failed with code ${code}\nCommand: ${fullCommand}\nWorkdir: ${workdir}\nstderr: ${redactAuth(stderr)}`,
          });
        }
      }
    });
    
    gitProcess.on('error', (err) => {
      clearTimeout(timeout);
      process.removeListener('SIGINT', sigintHandler);
      restoreRemote();
      resolve({ 
        success: false,
        error: `Git push failed: ${err.message}\nCommand: ${fullCommand}\nWorkdir: ${workdir}`,
      });
    });
  });
}

/**
 * Result of pushWithRetry
 */
export interface PushWithRetryResult {
  success: boolean;
  error?: string;
  conflictedFiles?: string[];  // Files with conflicts if rebase failed
}

/**
 * Push with auto-retry on rejection.
 * If push is rejected because remote has newer commits, fetches and rebases, then retries.
 * 
 * WHY: Common scenario when CodeRabbit or another user pushes while prr is working.
 * Auto-retry makes the workflow smoother without manual intervention.
 * 
 * WHY rebase instead of merge: Keeps history clean. Our fix commits go on top.
 * 
 * NEW: onConflict callback allows caller to resolve conflicts (e.g., with LLM).
 * If provided and conflicts occur, calls callback. If callback returns true (resolved),
 * continues the rebase and retries push.
 */
export async function pushWithRetry(
  git: SimpleGit, 
  branch: string, 
  options?: { 
    force?: boolean; 
    onPullNeeded?: () => void; 
    githubToken?: string;
    onConflict?: (conflictedFiles: string[]) => Promise<boolean>;  // Returns true if conflicts resolved
    maxRetries?: number;  // Max push retries (default 3)
  }
): Promise<void> {
  const maxRetries = options?.maxRetries ?? 3;
  let attempts = 0;
  
  while (attempts < maxRetries) {
    attempts++;
    const result = await push(git, branch, options?.force, options?.githubToken);
    
    if (result.success) {
      return;
    }
    
    if (!result.rejected) {
      // Non-rejected failure (auth, network, etc.) - don't retry
      throw new Error(result.error || 'Push failed');
    }
    
    // Push was rejected - remote has newer commits
    debug(`Push rejected (attempt ${attempts}/${maxRetries}), attempting fetch + rebase + retry`);
    options?.onPullNeeded?.();
    
    // Fetch and rebase to handle divergent branches
    try {
      // First fetch
      await git.fetch('origin', branch);
      debug('Fetch successful');
      
      // Then rebase our commits on top of remote
      await git.rebase([`origin/${branch}`]);
      debug('Rebase successful, retrying push');
      // Loop continues to retry push
    } catch (syncError) {
      const syncMsg = syncError instanceof Error ? syncError.message : String(syncError);
      debug('Rebase failed', { error: syncMsg, attempt: attempts });
      
      // Check if it's a conflict
      if (syncMsg.includes('CONFLICT') || syncMsg.includes('conflict')) {
        // Get conflicted files
        const status = await git.status();
        const conflictedFiles = status.conflicted || [];
        
        // If we have a conflict handler, try to use it
        if (options?.onConflict && conflictedFiles.length > 0) {
          debug('Calling onConflict handler', { files: conflictedFiles });
          
          try {
            const resolved = await options.onConflict(conflictedFiles);
            
            if (resolved) {
              // Conflicts resolved - stage files and continue rebase
              debug('Conflicts resolved by handler, continuing rebase');
              await git.add('.');
              
              try {
                await git.rebase(['--continue']);
                debug('Rebase continued successfully');
                // Loop continues to retry push
                continue;
              } catch (continueError) {
                // Rebase continue failed - check if more conflicts or done
                const continueMsg = continueError instanceof Error ? continueError.message : String(continueError);
                if (continueMsg.includes('No changes') || continueMsg.includes('nothing to commit')) {
                  // Rebase is actually done
                  debug('Rebase complete (no more changes)');
                  continue;
                }
                // More conflicts - could loop but for now bail
                debug('Rebase continue failed', { error: continueMsg });
              }
            }
          } catch (handlerError) {
            debug('onConflict handler failed', { error: handlerError });
          }
        }
        
        // Handler didn't resolve or no handler - abort rebase
        try {
          await git.rebase(['--abort']);
        } catch {
          // Ignore abort errors
        }
        
        throw new Error(`Push rejected and rebase has conflicts in: ${conflictedFiles.join(', ')}. Manual resolution needed.\nOriginal: ${result.error}`);
      }
      
      // Non-conflict rebase failure - abort and throw
      try {
        await git.rebase(['--abort']);
      } catch {
        // Ignore abort errors
      }
      
      throw new Error(`Push rejected and sync failed: ${syncMsg}\nOriginal: ${result.error}`);
    }
  }
  
  // Exhausted retries
  throw new Error(`Push failed after ${maxRetries} attempts. Remote may be receiving concurrent pushes.`);
}

export async function getCurrentBranch(git: SimpleGit): Promise<string> {
  const result = await git.branch();
  return result.current;
}

export async function getLastCommitHash(git: SimpleGit): Promise<string> {
  const log = await git.log({ maxCount: 1 });
  return log.latest?.hash || '';
}

/**
 * Commit verified fixes from an iteration with prr-fix markers for recovery.
 * 
 * WHY markers: On restart, we scan git log for these markers to recover which
 * fixes were verified, even if the state file is lost or corrupted.
 * 
 * WHY check status first: Prevents "nothing to commit" errors. Also handles
 * case where changes were already committed or the fixer made no changes.
 * 
 * Returns null if no changes to commit.
 */
export async function commitIteration(
  git: SimpleGit,
  verifiedCommentIds: string[],
  iterationNumber: number,
  fixedIssues?: Array<{ filePath: string; comment: string }>
): Promise<CommitResult | null> {
  // Check if there are changes to commit (Trap 2)
  const status = await git.status();
  const hasChanges = !status.isClean();
  
  if (!hasChanges || verifiedCommentIds.length === 0) {
    return null; // Nothing to commit
  }

  await stageAll(git);

  // Build commit message with prr-fix markers (normalized to lowercase - Trap 6)
  const markers = verifiedCommentIds
    .map(id => `prr-fix:${id.toLowerCase()}`)
    .join('\n');
  
  // Generate a meaningful commit message from the fixed issues
  // WHY: "fix(prr): address 6 review comment(s)" says NOTHING about what changed
  const firstLine = generateCommitFirstLine(fixedIssues || [], status.files.map(f => f.path));
  
  const message = [
    firstLine,
    '',
    `Iteration ${iterationNumber}`,
    '',
    markers,
  ].join('\n');

  // Skip pre-commit hooks for automated commits (Trap 10)
  const result = await git.commit(message, { '--no-verify': null });

  return {
    hash: result.commit,
    message,
    filesChanged: result.summary.changes,
  };
}

/**
 * Scan git log for prr-fix markers to recover verification state.
 * 
 * WHY: Git commits are durable. On restart, we can recover which fixes were
 * already verified by scanning the commit history for our markers.
 * 
 * Scope to branch commits (Trap 1): Only search commits that are on this branch
 * since it diverged from main, avoiding false positives from merged commits.
 */
export async function scanCommittedFixes(git: SimpleGit, branch: string): Promise<string[]> {
  try {
    // Find the base branch - try common names
    const baseBranches = ['origin/main', 'origin/master', 'origin/develop'];
    let baseBranch: string | null = null;
    
    for (const candidate of baseBranches) {
      try {
        await git.raw(['rev-parse', '--verify', candidate]);
        baseBranch = candidate;
        break;
      } catch {
        // Branch doesn't exist, try next
      }
    }
    
    // If no common base branch found, fall back to searching all history
    // This is less precise but won't fail
    // Note: simple-git doesn't handle --grep properly, so use raw git command
    const logArgs = baseBranch
      ? ['log', '--grep=prr-fix:', '--format=%B', `${baseBranch}..${branch}`]
      : ['log', '--grep=prr-fix:', '--format=%B', '-n', '100'];
    
    debug('scanCommittedFixes', { baseBranch, branch, logArgs });
    const logOutput = await git.raw(logArgs);
    
    const commentIds: string[] = [];
    
    // Parse all prr-fix:ID markers from commit messages
    if (logOutput) {
      const matches = logOutput.matchAll(/prr-fix:(\S+)/gi);
      for (const match of matches) {
        commentIds.push(match[1].toLowerCase());
      }
    }
    
    // Dedupe in case the same fix was committed multiple times
    return [...new Set(commentIds)];
  } catch (error) {
    debug('scanCommittedFixes error', { error: String(error) });
    return []; // No commits or error - safe to continue
  }
}

/**
 * Generate a meaningful first line for a commit message.
 * 
 * WHY: Generic messages like "fix(prr): address 6 review comment(s)" are useless.
 * Commit history should describe WHAT changed, not that a tool was used.
 * 
 * Strategy:
 * 1. Extract common directory/module from changed files → use as scope
 * 2. Extract keywords from review comments → describe the change
 * 3. Fall back to file-based description if no comments provided
 */
function generateCommitFirstLine(
  fixedIssues: Array<{ filePath: string; comment: string }>,
  changedFiles: string[]
): string {
  // Get unique file paths from issues or git status
  const filePaths = fixedIssues.length > 0
    ? [...new Set(fixedIssues.map(i => i.filePath))]
    : changedFiles;
  
  // Determine scope from common path component
  const scope = extractScope(filePaths);
  
  // Try to extract meaningful description from comments
  const description = extractDescription(fixedIssues, filePaths);
  
  // Build first line (max 72 chars for git conventions)
  const firstLine = scope 
    ? `fix(${scope}): ${description}`
    : `fix: ${description}`;
  
  // Truncate if too long while keeping it meaningful
  if (firstLine.length > 72) {
    return firstLine.slice(0, 69) + '...';
  }
  
  return firstLine;
}

/**
 * Extract a meaningful scope from file paths.
 * 
 * WHY: The repo context is implicit - don't include redundant repo/package names.
 * Examples:
 *   ['src/api/voice/route.ts'] → 'voice-api'
 *   ['packages/client/src/auth.ts'] → 'auth' (not 'client' - that's the package)
 *   ['packages/plugin-babylon/src/memory.ts'] → 'memory' (not 'plugin-babylon')
 *   ['src/utils.ts'] → 'utils'
 */
function extractScope(filePaths: string[]): string | null {
  if (filePaths.length === 0) return null;
  
  // Find common directory patterns
  const dirCounts = new Map<string, number>();
  
  for (const path of filePaths) {
    const parts = path.split('/');
    
    // Skip generic top-level directories (monorepo structure, framework dirs)
    const skipDirs = ['src', 'lib', 'app', 'packages', 'plugins', 'apps', 'components', 'routes', 'dist', 'build'];
    
    // Look for meaningful directory names
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts[i];
      
      // Skip generic directories
      if (skipDirs.includes(dir)) continue;
      
      // Strip redundant prefixes (plugin-, package-, @scope/)
      let cleanDir = dir;
      cleanDir = cleanDir.replace(/^plugin-/, '');
      cleanDir = cleanDir.replace(/^package-/, '');
      cleanDir = cleanDir.replace(/^@[^/]+\//, ''); // @scope/name → name
      
      // Skip if it's still too generic after cleaning
      if (cleanDir.length < 3 || skipDirs.includes(cleanDir)) continue;
      
      // For api routes, look at the next level (e.g., api/voice → voice-api)
      if (dir === 'api' && parts[i + 1]) {
        const apiScope = `${parts[i + 1]}-api`;
        dirCounts.set(apiScope, (dirCounts.get(apiScope) || 0) + 1);
        continue; // Don't also count 'api' itself
      }
      
      dirCounts.set(cleanDir, (dirCounts.get(cleanDir) || 0) + 1);
    }
    
    // For single-file changes, consider the file name itself
    if (filePaths.length === 1) {
      const fileName = parts[parts.length - 1].replace(/\.[^.]+$/, '');
      // Use file name if it's meaningful and not too long
      if (fileName && fileName.length < 15 && fileName !== 'index' && fileName !== 'main') {
        return fileName;
      }
    }
  }
  
  // Return most common scope
  let bestScope: string | null = null;
  let bestCount = 0;
  for (const [dir, count] of dirCounts) {
    if (count > bestCount) {
      bestCount = count;
      bestScope = dir;
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
