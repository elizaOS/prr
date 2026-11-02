import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { pullsGetMock } = vi.hoisted(() => ({
  pullsGetMock: vi.fn(),
}));

vi.mock('@octokit/rest', () => ({
  Octokit: vi.fn().mockImplementation(() => ({
    pulls: { get: pullsGetMock },
    users: { getAuthenticated: vi.fn().mockResolvedValue({ data: { login: 'test-user' } }) },
  })),
}));

vi.mock('@octokit/graphql', () => ({
  graphql: Object.assign(vi.fn(), {
    defaults: vi.fn(() => vi.fn()),
  }),
}));

import { GitHubAPI } from '../tools/prr/github/api.js';

function restPull(partial: {
  mergeable: boolean | null;
  mergeable_state?: string | null;
}): Record<string, unknown> {
  return {
    title: 't',
    body: '',
    head: { ref: 'feat', sha: 'abc', repo: { clone_url: 'https://github.com/o/r.git' } },
    base: { ref: 'main' },
    mergeable_state: 'unknown',
    ...partial,
  };
}

describe('GitHubAPI.getPRInfo mergeable polling', () => {
  beforeEach(() => {
    pullsGetMock.mockReset();
    process.env.PRR_MERGEABLE_POLL_MS = '0';
    delete process.env.PRR_MERGEABLE_POLL_ATTEMPTS;
  });

  afterEach(() => {
    delete process.env.PRR_MERGEABLE_POLL_MS;
    delete process.env.PRR_MERGEABLE_POLL_ATTEMPTS;
  });

  it('polls pulls.get until mergeable is non-null', async () => {
    pullsGetMock
      .mockResolvedValueOnce({ data: restPull({ mergeable: null }) })
      .mockResolvedValueOnce({ data: restPull({ mergeable: true, mergeable_state: 'clean' }) });

    const api = new GitHubAPI('fake-token');
    const info = await api.getPRInfo('o', 'r', 1);

    expect(info.mergeable).toBe(true);
    expect(info.mergeableState).toBe('clean');
    expect(pullsGetMock).toHaveBeenCalledTimes(2);
  });

  it('does not poll when PRR_MERGEABLE_POLL_ATTEMPTS is 0', async () => {
    process.env.PRR_MERGEABLE_POLL_ATTEMPTS = '0';
    pullsGetMock.mockResolvedValue({ data: restPull({ mergeable: null, mergeable_state: 'unknown' }) });

    const api = new GitHubAPI('fake-token');
    const info = await api.getPRInfo('o', 'r', 1);

    expect(info.mergeable).toBe(null);
    expect(info.mergeableState).toBe('unknown');
    expect(pullsGetMock).toHaveBeenCalledTimes(1);
  });

  it('stops after max extra polls and leaves mergeable null', async () => {
    process.env.PRR_MERGEABLE_POLL_ATTEMPTS = '2';
    pullsGetMock.mockResolvedValue({ data: restPull({ mergeable: null }) });

    const api = new GitHubAPI('fake-token');
    const info = await api.getPRInfo('o', 'r', 1);

    expect(info.mergeable).toBe(null);
    expect(pullsGetMock).toHaveBeenCalledTimes(3);
  });

  it('maps null mergeable_state to unknown', async () => {
    pullsGetMock.mockResolvedValue({
      data: restPull({ mergeable: true, mergeable_state: null }),
    });

    const api = new GitHubAPI('fake-token');
    const info = await api.getPRInfo('o', 'r', 1);

    expect(info.mergeable).toBe(true);
    expect(info.mergeableState).toBe('unknown');
    expect(pullsGetMock).toHaveBeenCalledTimes(1);
  });

  it('sets baseRepoCloneUrl when head and base repos differ (fork PR)', async () => {
    pullsGetMock.mockResolvedValue({
      data: {
        title: 't',
        body: '',
        head: {
          ref: 'feat',
          sha: 'abc',
          repo: {
            full_name: 'contributor/eliza',
            clone_url: 'https://github.com/contributor/eliza.git',
          },
        },
        base: {
          ref: 'develop',
          repo: {
            full_name: 'elizaOS/eliza',
            clone_url: 'https://github.com/elizaOS/eliza.git',
          },
        },
        mergeable: false,
        mergeable_state: 'dirty',
      },
    });

    const api = new GitHubAPI('fake-token');
    const info = await api.getPRInfo('elizaOS', 'eliza', 7008);

    expect(info.baseRepoCloneUrl).toBe('https://github.com/elizaOS/eliza.git');
    expect(info.cloneUrl).toBe('https://github.com/contributor/eliza.git');
  });
});
