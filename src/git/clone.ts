import { simpleGit, SimpleGit } from 'simple-git';
import { existsSync } from 'fs';
import { join } from 'path';

export interface GitOperations {
  git: SimpleGit;
  workdir: string;
}

export async function cloneOrUpdate(
  cloneUrl: string,
  branch: string,
  workdir: string,
  githubToken?: string
): Promise<GitOperations> {
  // Inject token into clone URL for authentication
  let authUrl = cloneUrl;
  if (githubToken && cloneUrl.startsWith('https://')) {
    authUrl = cloneUrl.replace('https://', `https://${githubToken}@`);
  }

  const gitDir = join(workdir, '.git');
  const isExistingRepo = existsSync(gitDir);

  let git: SimpleGit;

  if (isExistingRepo) {
    // Existing repo - fetch and reset
    git = simpleGit(workdir);
    
    console.log('Existing workdir found, fetching latest changes...');
    await git.fetch('origin', branch);
    await git.checkout(branch);
    await git.reset(['--hard', `origin/${branch}`]);
    
    console.log(`Updated to latest ${branch}`);
  } else {
    // Fresh clone
    git = simpleGit();
    
    console.log(`Cloning repository to ${workdir}...`);
    await git.clone(authUrl, workdir, ['--branch', branch, '--single-branch']);
    
    git = simpleGit(workdir);
    console.log(`Cloned ${branch} successfully`);
  }

  return { git, workdir };
}

export async function getChangedFiles(git: SimpleGit): Promise<string[]> {
  const status = await git.status();
  return [
    ...status.modified,
    ...status.created,
    ...status.deleted,
    ...status.renamed.map((r) => r.to),
  ];
}

export async function getDiff(git: SimpleGit, file?: string): Promise<string> {
  if (file) {
    return git.diff(['--', file]);
  }
  return git.diff();
}

export async function getDiffForFile(git: SimpleGit, file: string): Promise<string> {
  try {
    return await git.diff(['HEAD', '--', file]);
  } catch {
    // File might be new (untracked)
    return await git.diff(['--no-index', '/dev/null', file]).catch(() => '');
  }
}

export async function hasChanges(git: SimpleGit): Promise<boolean> {
  const status = await git.status();
  return !status.isClean();
}
