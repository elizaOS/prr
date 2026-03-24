/**
 * Git repository setup helpers for testing
 */

import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { execFileSync } from 'child_process';
import type { SimpleGit } from 'simple-git';
import simpleGit from 'simple-git';

export interface TestRepoOptions {
  files?: Array<{ path: string; content: string }>;
  commits?: Array<{ message: string; files: Array<{ path: string; content: string }> }>;
  baseBranch?: string;
  featureBranch?: string;
}

export interface TestRepo {
  git: SimpleGit;
  workdir: string;
  cleanup: () => void;
}

/**
 * Create a temporary git repository for testing
 */
export function createTestRepo(options: TestRepoOptions = {}): TestRepo {
  const workdir = mkdtempSync(join(tmpdir(), 'test-repo-'));
  const git = simpleGit(workdir);

  // Initialize git repo
  execFileSync('git', ['init'], { cwd: workdir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: workdir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workdir, stdio: 'ignore' });

  const baseBranch = options.baseBranch || 'main';
  const featureBranch = options.featureBranch || 'feature';

  // Create initial commit on base branch
  writeFileSync(join(workdir, 'README.md'), '# Test Repo\n', 'utf-8');
  execFileSync('git', ['add', 'README.md'], { cwd: workdir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: workdir, stdio: 'ignore' });
  execFileSync('git', ['branch', '-m', baseBranch], { cwd: workdir, stdio: 'ignore' });

  // Add initial files if provided
  if (options.files) {
    for (const file of options.files) {
      const filePath = join(workdir, file.path);
      const dir = require('path').dirname(filePath);
      const fs = require('fs');
      fs.mkdirSync(dir, { recursive: true });
      writeFileSync(filePath, file.content, 'utf-8');
    }
    execFileSync('git', ['add', '.'], { cwd: workdir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'Add initial files'], { cwd: workdir, stdio: 'ignore' });
  }

  // Create feature branch and add commits if provided
  if (options.commits && options.commits.length > 0) {
    execFileSync('git', ['checkout', '-b', featureBranch], { cwd: workdir, stdio: 'ignore' });
    for (const commit of options.commits) {
      for (const file of commit.files) {
        const filePath = join(workdir, file.path);
        const dir = require('path').dirname(filePath);
        const fs = require('fs');
        fs.mkdirSync(dir, { recursive: true });
        writeFileSync(filePath, file.content, 'utf-8');
      }
      execFileSync('git', ['add', '.'], { cwd: workdir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', commit.message], { cwd: workdir, stdio: 'ignore' });
    }
  }

  return {
    git,
    workdir,
    cleanup: () => {
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}
