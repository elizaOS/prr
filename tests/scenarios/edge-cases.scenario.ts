/**
 * Edge case scenario tests
 */

import { describe, it, expect } from 'vitest';
import { ScenarioBuilder } from '../test-utils/scenario-builder.js';
import { runPRRScenario } from './helpers/workflow-helpers.js';
import { expectDismissed } from './helpers/assertions.js';

describe('scenario: edge cases', () => {
  it('handles already fixed comments', async () => {
    const scenario = new ScenarioBuilder()
      .withPR({
        owner: 'test-org',
        repo: 'test-repo',
        number: 1,
        title: 'Already fixed',
        branch: 'feature',
        baseBranch: 'main',
        files: [
          { path: 'src/utils.ts', content: 'export function foo() { return value ?? null; }\n' },
        ],
        comments: [
          {
            id: 'c1',
            path: 'src/utils.ts',
            line: 1,
            body: 'Use nullish coalescing instead of non-null assertion',
          },
        ],
      })
      .withLLMClient({
        verificationResponses: { c1: 'YES' },
      })
      .build();

    const result = await runPRRScenario(scenario, {});
    expect(result.success).toBe(true);
  });

  it('handles deleted file comments', async () => {
    const scenario = new ScenarioBuilder()
      .withPR({
        owner: 'test-org',
        repo: 'test-repo',
        number: 1,
        title: 'Deleted file',
        branch: 'feature',
        baseBranch: 'main',
        files: [],
        comments: [
          {
            id: 'c1',
            path: 'src/old.ts',
            line: 10,
            body: 'This function should use async/await',
          },
        ],
      })
      .build();

    const result = await runPRRScenario(scenario, {});
    // TODO: Verify comment is dismissed with file-not-found category
    // expectDismissed('c1', 'file-not-found', result);
    expect(result.success).toBe(true);
  });

  it('handles stale verification', async () => {
    const scenario = new ScenarioBuilder()
      .withPR({
        owner: 'test-org',
        repo: 'test-repo',
        number: 1,
        title: 'Stale verification',
        branch: 'feature',
        baseBranch: 'main',
        files: [
          { path: 'src/utils.ts', content: 'export function foo() { return null!; }\n' },
        ],
        comments: [
          {
            id: 'c1',
            path: 'src/utils.ts',
            line: 1,
            body: 'Use nullish coalescing instead of non-null assertion',
          },
        ],
      })
      .withLLMClient({
        verificationResponses: { c1: 'STALE' },
      })
      .build();

    const result = await runPRRScenario(scenario, {});
    expect(result.success).toBe(true);
  });

  it('handles no changes from fixer', async () => {
    const scenario = new ScenarioBuilder()
      .withPR({
        owner: 'test-org',
        repo: 'test-repo',
        number: 1,
        title: 'No changes',
        branch: 'feature',
        baseBranch: 'main',
        files: [
          { path: 'src/utils.ts', content: 'export function foo() { return null!; }\n' },
        ],
        comments: [
          {
            id: 'c1',
            path: 'src/utils.ts',
            line: 1,
            body: 'Use nullish coalescing instead of non-null assertion',
          },
        ],
      })
      .build();

    const result = await runPRRScenario(scenario, {});
    expect(result.success).toBe(true);
  });
});
