/**
 * Git information queries - read-only operations
 * 
 * WHY this module exists:
 * Separated from commit operations because these are pure queries that don't
 * modify repository state. This makes them safe to call anywhere without
 * side effects.
 * 
 * WHY not in git-clone module:
 * These queries are used during commit workflows, not clone/update workflows.
 * Grouping by usage pattern (when they're called) rather than by git subsystem
 * (branch vs commit commands) improves cohesion.
 * 
 * USAGE: Call these before committing to get context like current branch name
 * for commit messages or to verify HEAD state.
 */
import type { SimpleGit } from 'simple-git';

/**
 * Get the name of the currently checked out branch
 * 
 * WHY return string instead of branch object:
 * Callers almost always just need the name, not the full branch metadata.
 * Returning only what's needed keeps the API simple and focused.
 * 
 * @throws If git operations fail (repo not initialized, etc)
 */
export async function getCurrentBranch(git: SimpleGit): Promise<string> {
  const result = await git.branch();
  return result.current;
}

/**
 * Get the commit hash of HEAD
 * 
 * WHY throw on no commits:
 * An empty repository is an error state for our workflows - we always
 * expect at least an initial commit to exist. Throwing makes this
 * assumption explicit and prevents silent failures downstream.
 * 
 * WHY maxCount: 1:
 * Performance optimization - we only need the latest commit, so don't
 * fetch the entire history.
 * 
 * @returns Full SHA-1 commit hash (40 hex characters)
 * @throws If repository has no commits
 */
export async function getLastCommitHash(git: SimpleGit): Promise<string> {
  const log = await git.log({ maxCount: 1 });
  if (!log.latest) {
    throw new Error('No commits found');
  }
  return log.latest.hash;
}
