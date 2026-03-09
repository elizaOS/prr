import { describe, expect, it } from 'vitest';
import {
  buildLifecycleAwareVerificationSnippet,
  commentNeedsLifecycleContext,
} from '../tools/prr/workflow/fix-verification.js';

describe('commentNeedsLifecycleContext', () => {
  it('detects memory leak and cleanup lifecycle comments', () => {
    expect(
      commentNeedsLifecycleContext({
        comment: 'latestResponseIds Map potential memory leak; entries are never cleared on early returns.',
      })
    ).toBe(true);

    expect(
      commentNeedsLifecycleContext({
        comment: 'Cache cleanup is missing and stale entries can survive forever.',
      })
    ).toBe(true);
  });

  it('does not flag ordinary local-line comments as lifecycle issues', () => {
    expect(
      commentNeedsLifecycleContext({
        comment: 'Use nullish coalescing here so undefined is not rendered.',
      })
    ).toBe(false);
  });
});

describe('buildLifecycleAwareVerificationSnippet', () => {
  it('includes declaration and distant cleanup/usage sites for tracked symbols', () => {
    const content = [
      'const setup = true;',
      'const latestResponseIds = new Map<string, Map<string, string>>();',
      'function start(agentId: string, roomId: string, responseId: string) {',
      '  let agentResponses = latestResponseIds.get(agentId);',
      '  if (!agentResponses) {',
      '    agentResponses = new Map<string, string>();',
      '    latestResponseIds.set(agentId, agentResponses);',
      '  }',
      '  agentResponses.set(roomId, responseId);',
      '}',
      '',
      'function maybeSkip(agentId: string) {',
      '  if (!latestResponseIds.get(agentId)) return;',
      '}',
      '',
      'function finish(agentId: string, roomId: string) {',
      '  const agentResponses = latestResponseIds.get(agentId);',
      '  if (!agentResponses) return;',
      '  agentResponses.delete(roomId);',
      '  if (agentResponses.size === 0) latestResponseIds.delete(agentId);',
      '}',
    ].join('\n');

    const snippet = buildLifecycleAwareVerificationSnippet(
      content,
      'packages/typescript/src/services/message.ts',
      2,
      'The `latestResponseIds` Map potential memory leak still exists because cleanup is skipped on early returns.'
    );

    expect(snippet).toContain('Lifecycle excerpts for `latestResponseIds`');
    expect(snippet).toContain('2: const latestResponseIds = new Map<string, Map<string, string>>();');
    expect(snippet).toContain('7:     latestResponseIds.set(agentId, agentResponses);');
    expect(snippet).toContain('17:   const agentResponses = latestResponseIds.get(agentId);');
    expect(snippet).toContain('20:   if (agentResponses.size === 0) latestResponseIds.delete(agentId);');
  });

  it('returns null when no lifecycle symbol can be identified', () => {
    const snippet = buildLifecycleAwareVerificationSnippet(
      'const value = 1;\nreturn value;',
      'demo.ts',
      null,
      'This line should use a clearer variable name.'
    );

    expect(snippet).toBeNull();
  });
});
