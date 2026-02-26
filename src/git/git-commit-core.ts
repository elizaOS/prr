/**
 * Core commit operations - basic staging and committing
 * 
 * WHY this module exists:
 * Extracted from git/commit.ts to separate fundamental commit operations
 * from more complex push/retry logic and message formatting.
 * 
 * WHY these functions are together:
 * Both functions deal with the basic git commit workflow: stage changes,
 * then commit them. They are the building blocks used by other modules.
 * 
 * DESIGN: Simple, focused functions that wrap simple-git with clear
 * return types. No complex retry logic or timeout handling here.
 */
import { unlinkSync, existsSync } from 'fs';
import { join } from 'path';
import type { SimpleGit } from 'simple-git';
import { debug } from '../logger.js';

export interface CommitResult {
  hash: string;
  message: string;
  filesChanged: number;
  /** File paths that were actually staged and committed (relative to repo root).
   * WHY: Callers scope commit messages to these files so the message doesn't list
   * issues in files that weren't changed in this commit. */
  stagedFiles: string[];
}

/**
 * Patterns that indicate tool markup was accidentally left in source files.
 * These are the XML-like edit instructions from the LLM-API runner that should
 * be parsed and applied, never committed as raw text.
 *
 * We check for the COMBINATION of <search> + <replace> or <change path="...">
 * to avoid false positives from legitimate XML/HTML code that might use one
 * of these tag names individually.
 *
 * WHY also check TOOL_MARKER_FILES: PRR writes __fix-notes.md etc. for the
 * fixer; those are tool artifacts, not user code. If the fixer leaves them
 * staged, we unstage them so the commit only contains real source changes.
 */
const TOOL_MARKUP_PATTERN = /<change\s+path="[^"]+">[\s\S]*?<search>[\s\S]*?<\/search>[\s\S]*?<replace>/;
const TOOL_MARKER_FILES = [
  '__cache-check-needed.md',   // PRR tool notes
  '__fix-notes.md',            // PRR tool notes
];

/**
 * Directories that the fixer should never modify.
 * These are tool-managed (lessons, state) and any edits to them are accidental.
 * Exported so other modules (e.g. dismissal-comments) can skip them consistently.
 *
 * WHY .prr/: Lessons and state live there. Fixer edits would corrupt the
 * learning system or state and get auto-reverted, wasting a fix iteration.
 */
export const PROTECTED_DIRS = ['.prr/'];

/**
 * Matches common test file names so we can reject empty/placeholder test files.
 * Covers: *.test.ts, *.spec.ts, *_test.ts, test_*.ts, and common extensions.
 */
const TEST_FILE_PATTERN = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$|_test\.(ts|tsx|js|go|py|rs)$/;

function isTestFileName(filePath: string): boolean {
  if (TEST_FILE_PATTERN.test(filePath)) return true;
  const base = filePath.split('/').pop() || '';
  return /^test_.*\.(ts|tsx|js|py)$/.test(base);
}

/** Max content length (after trim) to consider "placeholder"; no test keywords => likely accidental. */
const PLACEHOLDER_MAX_LEN = 50;
/** Test/assert keywords that indicate real test code. */
const TEST_KEYWORDS = /\b(test|it|describe|expect|assert\.|require\s*\()\s*[\(\"]/;

/**
 * Stage all changes in the repository
 * 
 * WHY use git add -A instead of git add .:
 * -A stages all changes including deletions and renames, not just modifications.
 * This ensures we capture the complete state of the working directory.
 */
export async function stageAll(git: SimpleGit): Promise<void> {
  await git.add('-A');
}

/**
 * Create a commit with all current changes
 * 
 * WHY "squash" in the name:
 * This function stages and commits all outstanding changes in one operation,
 * effectively "squashing" the working directory state into a single commit.
 * The name distinguishes it from more granular commit operations.
 * 
 * WHY separate title and body:
 * Follows git best practices - first line is the summary (shows in git log),
 * body provides additional context (shows in git show). This makes commits
 * more readable in both compact and detailed views.
 * 
 * @param git - SimpleGit instance for the repository
 * @param message - Commit title/summary (first line)
 * @param body - Optional detailed description
 * @returns Commit hash, message, and number of files changed; null if nothing to commit
 */
export async function squashCommit(
  git: SimpleGit,
  message: string,
  body?: string
): Promise<CommitResult | null> {
  // Stage all changes
  await stageAll(git);

  // Pre-commit safety: tool artifacts, empty test files, etc. (see runPreCommitChecks).
  await runPreCommitChecks(git);

  // If everything was unstaged (e.g. only .prr/ or tool artifacts), nothing to commit.
  // WHY: Avoids "nothing to commit" error and prevents empty/no-op commits that
  // would still trigger push + 300s wait (Everything up-to-date).
  const staged = await git.diff(['--cached', '--name-only']);
  if (!staged || staged.trim() === '') {
    return null;
  }

  const stagedFiles = staged.trim().split('\n').filter(Boolean);

  // Build commit message (title + optional body separated by blank line)
  const fullMessage = body ? `${message}\n\n${body}` : message;

  // Commit
  const result = await git.commit(fullMessage);

  return {
    hash: result.commit,
    message,
    filesChanged: result.summary.changes,
    stagedFiles,
  };
}

/**
 * Run all pre-commit safety checks: unstage tool artifacts and empty/placeholder test files.
 * Exported so both squashCommit and commitIteration can use it.
 */
export async function runPreCommitChecks(git: SimpleGit): Promise<void> {
  await unstageToolArtifacts(git);
  await unstageEmptyTestFiles(git);
}

/**
 * Inspect staged changes for tool markup artifacts and unstage them.
 *
 * Checks two things:
 * 1. Files whose names match known tool-generated patterns (e.g., __cache-check-needed.md)
 * 2. Files whose staged diff contains raw <change><search>...</search><replace> markup
 *
 * For any matches, we `git checkout HEAD -- <file>` to restore the original and
 * `git rm --cached` for new files. This prevents tool debris from being committed
 * while still allowing the rest of the changes through.
 */
async function unstageToolArtifacts(git: SimpleGit): Promise<void> {
  try {
    // Get list of staged files
    const status = await git.status();
    const stagedFiles = [
      ...status.created,
      ...status.modified,
      ...status.renamed.map(r => r.to),
    ];

    if (stagedFiles.length === 0) return;

    const filesToRevert: string[] = [];
    const filesToRemove: string[] = []; // New files to unstage entirely

    for (const file of stagedFiles) {
      const basename = file.split('/').pop() || '';

      // Check protected directories (fixer should never modify these)
      if (PROTECTED_DIRS.some(dir => file.startsWith(dir))) {
        debug(`Tool artifact detected (protected dir): ${file}`);
        if (status.created.includes(file)) {
          filesToRemove.push(file);
        } else {
          filesToRevert.push(file);
        }
        continue;
      }

      // Check filename patterns
      if (TOOL_MARKER_FILES.some(pattern => basename === pattern) || (basename.startsWith('__') && basename.endsWith('.md'))) {
        debug(`Tool artifact detected (filename): ${file}`);
        if (status.created.includes(file)) {
          filesToRemove.push(file);
        } else {
          filesToRevert.push(file);
        }
        continue;
      // Review: distinguishes between created and modified tool artifacts for appropriate handling
      }

      // Check file content for tool markup (only for text-like files)
      if (/\.(ts|tsx|js|jsx|py|rs|go|md|json|yaml|yml|toml)$/.test(file)) {
        try {
          const diff = await git.diff(['--cached', '--', file]);
          if (TOOL_MARKUP_PATTERN.test(diff)) {
            debug(`Tool markup detected in staged diff: ${file}`);
            if (status.created.includes(file)) {
              filesToRemove.push(file);
            } else {
              filesToRevert.push(file);
            }
            continue; // Skip JSON block and any other checks for this file
          }
        } catch {
          // If diff fails, skip this file (don't block commit)
        }
      }

      // JSON files: reject any staged content that contains // comments or is invalid JSON
      if (file.endsWith('.json')) {
        const diff = await git.diff(['--cached', '--', file]);
        if (/^\+\s*\/\//m.test(diff)) {
          debug(`JSON file contains comment syntax: ${file}`);
          if (status.created.includes(file)) {
            filesToRemove.push(file);
          } else {
            filesToRevert.push(file);
          }
          continue;
        }
        let stagedContent: string;
        try {
          stagedContent = await git.raw(['show', ':0:' + file]);
        } catch {
          debug(`Could not read staged content for: ${file}`);
          continue;
        }
        try {
          if (typeof stagedContent === 'string') {
            JSON.parse(stagedContent);
          }
        } catch {
          debug(`Invalid JSON detected in staged file: ${file}`);
          if (status.created.includes(file)) {
            filesToRemove.push(file);
          } else {
            filesToRevert.push(file);
          }
        }
        continue;
      }
    }

    // Revert modified files to HEAD (removes the tool markup changes)
    for (const file of filesToRevert) {
      try {
        await git.checkout(['HEAD', '--', file]);
        console.log(`  ⚠ Reverted tool markup in ${file}`);
      } catch {
        debug(`Failed to revert tool artifact: ${file}`);
      }
    }

    // Remove new files that are tool artifacts
    for (const file of filesToRemove) {
      try {
        await git.raw(['rm', '--cached', file]);
        console.log(`  ⚠ Excluded tool artifact: ${file}`);
      } catch {
        debug(`Failed to unstage tool artifact: ${file}`);
      }
    }
  } catch (err) {
    // Non-fatal: if artifact detection fails, proceed with commit as-is
    debug('Tool artifact detection failed', { error: String(err) });
  }
}

/**
 * True if content is empty or looks like a placeholder (e.g. one blank line, no real test code).
 */
function isEmptyOrPlaceholder(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0) return true;
  if (trimmed.length > PLACEHOLDER_MAX_LEN) return false;
  if (TEST_KEYWORDS.test(trimmed)) return false;
  const lines = trimmed.split(/\n/).map(l => l.trim()).filter(Boolean);
  return lines.length <= 2;
}

/**
 * Unstage empty or placeholder test files so they are never committed.
 * New empty test files are also removed from the working tree so they are not re-staged next run.
 *
 * WHY: Fixers or users sometimes add a test file as a placeholder (e.g. test_fail.ts with one
 * blank line) and commit it by mistake. Review bots then flag "empty test file accidentally committed".
 */
async function unstageEmptyTestFiles(git: SimpleGit): Promise<void> {
  try {
    const status = await git.status();
    const stagedFiles = [
      ...status.created,
      ...status.modified,
      ...status.renamed.map(r => r.to),
    ];

    const testFilesToUnstage: { file: string; isNew: boolean }[] = [];

    for (const file of stagedFiles) {
      if (!isTestFileName(file)) continue;
      let stagedContent: string;
      try {
        stagedContent = await git.raw(['show', ':0:' + file]);
      } catch {
        continue; // e.g. binary or missing; skip
      }
      if (typeof stagedContent !== 'string') continue;
      if (!isEmptyOrPlaceholder(stagedContent)) continue;
      testFilesToUnstage.push({ file, isNew: status.created.includes(file) });
    }

    if (testFilesToUnstage.length === 0) return;

    const root = (await git.revparse(['--show-toplevel'])).trim();

    for (const { file, isNew } of testFilesToUnstage) {
      try {
        if (isNew) {
          await git.raw(['rm', '--cached', file]);
          const fullPath = join(root, file);
          if (existsSync(fullPath)) {
            unlinkSync(fullPath);
          }
          console.log(`  ⚠ Excluded empty test file (removed from commit and working tree): ${file}`);
        } else {
          await git.checkout(['HEAD', '--', file]);
          console.log(`  ⚠ Reverted empty/placeholder test file to HEAD: ${file}`);
        }
      } catch (err) {
        debug('Failed to unstage empty test file', { file, error: String(err) });
      }
    }
  } catch (err) {
    debug('Empty test file detection failed', { error: String(err) });
  }
}
