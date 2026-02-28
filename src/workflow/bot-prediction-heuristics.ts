/**
 * Heuristic prediction of likely bot feedback from diff content.
 * Runs rule-based checks on the commit diff (TODO, console.log, new file without test, etc.).
 * Display only; never blocks push.
 */
import type { SimpleGit } from 'simple-git';

export interface HeuristicMatch {
  path: string;
  line?: number;
  rule: string;
  suggestion: string;
}

const HEURISTIC_RULES: Array<{
  id: string;
  suggestion: string;
  test: (line: string, isAdded: boolean) => boolean;
}> = [
  {
    id: 'todo',
    suggestion: 'Unresolved TODO/FIXME — bots often flag tech debt; consider resolving or documenting.',
    test: (line) => /\b(TODO|FIXME|XXX|HACK)\b/i.test(line),
  },
  {
    id: 'console_log',
    suggestion: 'Remove debug code (console.log/debugger) before push.',
    test: (line, isAdded) => isAdded && (/\bconsole\.(log|debug|info|warn|error)\s*\(/.test(line) || /\bdebugger\s*;?/.test(line)),
  },
];

/**
 * Run heuristic checks on a diff string (e.g. from git diff HEAD~1 HEAD).
 * Pure function for testing; use runHeuristicPrediction for the full flow.
 */
export function runHeuristicPredictionOnDiff(
  fullDiff: string,
  changedFiles: string[]
): HeuristicMatch[] {
  if (changedFiles.length === 0) return [];

  const matches: HeuristicMatch[] = [];
  const seen = new Set<string>();

  const lines = fullDiff.split('\n');
  let currentPath: string | null = null;

  for (const line of lines) {
    const pathMatch = line.match(/^\+\+\+ b\/(.+)$/);
    if (pathMatch) {
      currentPath = pathMatch[1].trim();
      continue;
    }
    if (currentPath === null) continue;
    if (!changedFiles.includes(currentPath)) continue;

    const isAdded = line.startsWith('+') && !line.startsWith('+++');
    const content = isAdded ? line.slice(1) : line;

    for (const rule of HEURISTIC_RULES) {
      const key = `${currentPath}:${rule.id}`;
      if (seen.has(key)) continue;
      if (rule.test(content, isAdded)) {
        seen.add(key);
        matches.push({
          path: currentPath,
          rule: rule.id,
          suggestion: rule.suggestion,
        });
      }
    }
  }
  return matches;
}

/**
 * Run heuristic checks on the diff of the given files (commit HEAD~1..HEAD).
 * Uses simple line/regex scan; no AST or heavy parsing.
 */
export async function runHeuristicPrediction(
  git: SimpleGit,
  changedFiles: string[]
): Promise<HeuristicMatch[]> {
  if (changedFiles.length === 0) return [];

  let fullDiff: string;
  try {
    fullDiff = await git.raw(['diff', 'HEAD~1', 'HEAD']);
  } catch {
    return [];
  }

  const matches = runHeuristicPredictionOnDiff(fullDiff, changedFiles);

  const newSourceFiles = await detectNewSourceWithoutTest(git, changedFiles);
  const seen = new Set(matches.map((m) => `${m.path}:${m.rule}`));
  for (const path of newSourceFiles) {
    const key = `${path}:new_file_no_test`;
    if (!seen.has(key)) {
      seen.add(key);
      matches.push({
        path,
        rule: 'new_file_no_test',
        suggestion: 'Consider adding tests for new code — bots often suggest this.',
      });
    }
  }

  return matches;
}

/** Detect new (added) non-test source files that have no new test file in the same change set. */
async function detectNewSourceWithoutTest(
  git: SimpleGit,
  changedFiles: string[]
): Promise<string[]> {
  const testPattern = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$|_test\.(ts|tsx|js|go|py|rs)$|^test_.*\.(ts|tsx|js|py)$/;
  const sourcePattern = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|go)$/;

  const newSources: string[] = [];
  const newTests: string[] = [];

  try {
    const diff = await git.raw(['diff', 'HEAD~1', 'HEAD', '--name-status']);
    if (!diff.trim()) return [];

    for (const line of diff.split('\n')) {
      const m = line.match(/^([ADM])\s+(.+)$/);
      if (!m) continue;
      const [, status, path] = m;
      if (status === 'A' && changedFiles.includes(path)) {
        if (testPattern.test(path)) newTests.push(path);
        else if (sourcePattern.test(path)) newSources.push(path);
      }
    }
  } catch {
    return [];
  }

  // If there's at least one new test file, we don't flag (they may have added tests for one of the new sources)
  if (newTests.length > 0) return [];

  return newSources;
}
