import { describe, expect, it } from 'vitest';
import { summarizeGitHubError, logGitHubApiFailure } from '../tools/prr/github/github-api-errors.js';

describe('summarizeGitHubError', () => {
  it('extracts HttpError-like fields', () => {
    const err = {
      name: 'HttpError',
      message: '500 status code (no body)',
      status: 500,
      request: { method: 'POST', url: 'https://api.github.com/repos/o/r/pulls/1/reviews' },
      response: {
        headers: { 'x-github-request-id': 'ABC123:123456:7890AB' },
        data: '',
      },
    };
    const s = summarizeGitHubError(err);
    expect(s.httpStatus).toBe(500);
    expect(s.requestMethod).toBe('POST');
    expect(s.requestUrl).toContain('pulls/1/reviews');
    expect(s.requestId).toBe('ABC123:123456:7890AB');
  });

  it('handles GraphqlResponseError shape', () => {
    const err = {
      name: 'GraphqlResponseError',
      message: 'Request failed due to following response errors:\n - Something broke',
      errors: [{ message: 'Something broke' }],
      request: { url: 'https://api.github.com/graphql' },
    };
    const s = summarizeGitHubError(err);
    expect(s.graphqlErrorMessages).toEqual(['Something broke']);
    expect(s.requestUrl).toContain('graphql');
  });
});

describe('logGitHubApiFailure', () => {
  it('does not throw (4xx avoids server-error warn)', () => {
    const err = Object.assign(new Error('Not Found'), { status: 404 });
    expect(() => logGitHubApiFailure('test-phase', err, { pr: 1 })).not.toThrow();
  });
});
