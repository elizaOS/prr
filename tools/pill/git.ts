/**
 * Optional git commit: stage only files pill touched (and not pre-existing dirty), commit with plan summary.
 */
import _simpleGit from 'simple-git';
import type { SimpleGit } from 'simple-git';
import type { ImprovementPlan } from './types.js';

const createGit = _simpleGit as unknown as (dir: string) => SimpleGit;

export async function commitChanges(
  targetDir: string,
  plan: ImprovementPlan,
  touchedFiles: Set<string>,
  preDirtyPaths?: Set<string>
): Promise<void> {
  const git = createGit(targetDir);
  const isRepo = await git.checkIsRepo();
  if (!isRepo) {
    console.log('--commit requested but target directory is not a git repo; skipping commit.');
    return;
  }
  let files = [...touchedFiles];
  if (preDirtyPaths?.size) {
    files = files.filter((f) => !preDirtyPaths.has(f));
  }
  if (files.length === 0) {
    console.log('No new files to commit (all changed files were pre-existing dirty).');
    return;
  }
  try {
    await git.add(files);
    const summary = plan.summary.slice(0, 200);
    await git.commit(`pill: ${summary}`);
    console.log(`Committed ${files.length} file(s).`);
  } catch (err) {
    console.error('Git commit failed:', err instanceof Error ? err.message : err);
  }
}

export async function getPreDirtyPaths(targetDir: string): Promise<Set<string>> {
  const git = createGit(targetDir);
  if (!(await git.checkIsRepo())) return new Set();
  const status = await git.status();
  const paths = new Set<string>();
  for (const f of status.modified) paths.add(f);
  for (const f of status.not_added) paths.add(f);
  for (const f of status.created) paths.add(f);
  for (const f of status.deleted) paths.add(f);
  for (const r of status.renamed) {
    paths.add(r.from);
    paths.add(r.to);
  }
  return paths;
}
