/**
 * Scenario builder for test scenarios
 */

import type { PRInfo, ReviewComment } from '../../tools/prr/github/types.js';
import type { GitHubAPI } from '../../tools/prr/github/api.js';
import type { LLMClient } from '../../tools/prr/llm/client.js';
import { createMockGitHubAPI, type MockGitHubAPIOptions } from './github-mock.js';
import { createMockLLMClient, type MockLLMClientOptions } from './llm-mock.js';
import { createTestRepo, type TestRepoOptions } from './git-helpers.js';

export interface ScenarioPR {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body?: string;
  branch: string;
  baseBranch: string;
  files: Array<{ path: string; content: string }>;
  comments: Array<{
    id: string;
    path: string;
    line: number | null;
    body: string;
  }>;
}

export interface ScenarioContext {
  pr: PRInfo;
  comments: ReviewComment[];
  github: GitHubAPI;
  llm: LLMClient;
  repo?: {
    git: any;
    workdir: string;
    cleanup: () => void;
  };
}

export class ScenarioBuilder {
  private pr?: ScenarioPR;
  private githubOptions?: MockGitHubAPIOptions;
  private llmOptions?: MockLLMClientOptions;
  private repoOptions?: TestRepoOptions;

  withPR(pr: ScenarioPR): this {
    this.pr = pr;
    return this;
  }

  withGitHubAPI(options: MockGitHubAPIOptions): this {
    this.githubOptions = options;
    return this;
  }

  withLLMClient(options: MockLLMClientOptions): this {
    this.llmOptions = options;
    return this;
  }

  withRepo(options: TestRepoOptions): this {
    this.repoOptions = options;
    return this;
  }

  build(): ScenarioContext {
    if (!this.pr) {
      throw new Error('PR must be provided via withPR()');
    }

    // Convert scenario PR to PRInfo
    const prInfo: PRInfo = {
      owner: this.pr.owner,
      repo: this.pr.repo,
      number: this.pr.number,
      title: this.pr.title,
      body: this.pr.body || '',
      branch: this.pr.branch,
      baseBranch: this.pr.baseBranch,
      headSha: 'abc123',
      cloneUrl: `https://github.com/${this.pr.owner}/${this.pr.repo}.git`,
      mergeable: true,
      mergeableState: 'clean',
    };

    // Convert scenario comments to ReviewComment
    const comments: ReviewComment[] = this.pr.comments.map(c => ({
      id: c.id,
      threadId: `thread-${c.id}`,
      author: 'reviewer',
      path: c.path,
      line: c.line,
      body: c.body,
      createdAt: new Date().toISOString(),
    }));

    // Create mocks
    const github = this.githubOptions
      ? createMockGitHubAPI({ ...this.githubOptions, prInfo, comments })
      : createMockGitHubAPI({ prInfo, comments });

    const llm = createMockLLMClient(this.llmOptions);

    // Create repo if options provided
    const repo = this.repoOptions ? createTestRepo(this.repoOptions) : undefined;

    return {
      pr: prInfo,
      comments,
      github,
      llm,
      repo,
    };
  }
}
