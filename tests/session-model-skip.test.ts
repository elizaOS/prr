import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createStateContext,
  ensureRotationSession,
  hydrateRotationSessionFromPersistedState,
  persistRotationSessionToState,
} from '../tools/prr/state/state-context.js';
import { createInitialState } from '../tools/prr/state/types.js';
import * as Rotation from '../tools/prr/models/rotation.js';
import type { Runner } from '../shared/runners/types.js';
import type { CLIOptions } from '../tools/prr/cli.js';

const runner: Runner = {
  name: 'llm-api',
  displayName: 'LLM API',
  supportedModels: ['bad/model', 'good/model'],
  provider: 'elizacloud',
  run: async () => ({ success: true, output: '' }),
  isAvailable: async () => true,
  checkStatus: async () => ({ installed: true, ready: true }),
};

describe('session skip persistence (state file fields)', () => {
  beforeEach(() => {
    vi.stubEnv('PRR_SESSION_MODEL_SKIP_FAILURES', '3');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('hydrates skipped model keys from ctx.state session fields', () => {
    const stateContext = createStateContext('/tmp/w');
    stateContext.state = createInitialState('https://github.com/o/r/pull/1', 'branch', 'deadbeef');
    stateContext.state.sessionSkippedModelKeys = ['llm-api/bad/model'];
    stateContext.state.sessionModelStats = { 'llm-api/bad/model': { fixes: 0, failures: 3 } };
    hydrateRotationSessionFromPersistedState(stateContext);
    expect(ensureRotationSession(stateContext).skippedModelKeys.has('llm-api/bad/model')).toBe(true);
  });

  it('persistRotationSessionToState writes skip keys into ResolverState', () => {
    const stateContext = createStateContext('/tmp/w');
    stateContext.state = createInitialState('https://github.com/o/r/pull/2', 'branch', 'abc123');
    Rotation.recordSessionModelVerificationOutcome(stateContext, 'llm-api', 'bad/model', 0, 3);
    persistRotationSessionToState(stateContext);
    expect(stateContext.state.sessionSkippedModelKeys).toContain('llm-api/bad/model');
    expect(stateContext.state.sessionModelStats?.['llm-api/bad/model']?.failures).toBe(3);
  });
});

describe('recordSessionModelVerificationOutcome', () => {
  beforeEach(() => {
    vi.stubEnv('PRR_SESSION_MODEL_SKIP_FAILURES', '3');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('adds to skip set after threshold failures with zero fixes', () => {
    const stateContext = createStateContext('/tmp/w');
    Rotation.recordSessionModelVerificationOutcome(stateContext, 'llm-api', 'bad/model', 0, 1);
    Rotation.recordSessionModelVerificationOutcome(stateContext, 'llm-api', 'bad/model', 0, 1);
    expect(ensureRotationSession(stateContext).skippedModelKeys.has('llm-api/bad/model')).toBe(false);
    Rotation.recordSessionModelVerificationOutcome(stateContext, 'llm-api', 'bad/model', 0, 1);
    expect(ensureRotationSession(stateContext).skippedModelKeys.has('llm-api/bad/model')).toBe(true);
  });

  it('clears skip after a verified fix', () => {
    const stateContext = createStateContext('/tmp/w');
    Rotation.recordSessionModelVerificationOutcome(stateContext, 'llm-api', 'bad/model', 0, 3);
    expect(ensureRotationSession(stateContext).skippedModelKeys.has('llm-api/bad/model')).toBe(true);
    Rotation.recordSessionModelVerificationOutcome(stateContext, 'llm-api', 'bad/model', 1, 0);
    expect(ensureRotationSession(stateContext).skippedModelKeys.has('llm-api/bad/model')).toBe(false);
  });

  it('getCurrentModel skips session-bad model in rotation', () => {
    vi.stubEnv('PRR_SESSION_MODEL_SKIP_FAILURES', '1');
    const stateContext = createStateContext('/tmp/w');
    Rotation.recordSessionModelVerificationOutcome(stateContext, 'llm-api', 'bad/model', 0, 1);
    const modelIndices = new Map<string, number>([['llm-api', 0]]);
    const ctx: Rotation.RotationContext = {
      runner,
      runners: [runner],
      currentRunnerIndex: 0,
      modelIndices,
      modelFailuresInCycle: 0,
      modelsTriedThisToolRound: 0,
      progressThisCycle: 0,
      recommendedModelIndex: 0,
      runnersAttemptedInCycle: new Set(),
      disabledRunners: new Set(),
      stateContext,
    };
    const options = { modelRotation: true } as CLIOptions;
    const m = Rotation.getCurrentModel(ctx, options);
    expect(m).toBe('good/model');
    expect(modelIndices.get('llm-api')).toBe(1);
  });
});

describe('maybeResetSessionSkippedModelsAfterFixIteration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('clears each session skip after N fix iterations since that key was skipped', () => {
    vi.stubEnv('PRR_SESSION_MODEL_SKIP_RESET_AFTER_FIX_ITERATIONS', '2');
    const stateContext = createStateContext('/tmp/w');
    ensureRotationSession(stateContext).skippedModelKeys.add('llm-api/x');
    Rotation.maybeResetSessionSkippedModelsAfterFixIteration(stateContext, 1);
    expect(ensureRotationSession(stateContext).skippedModelKeys.has('llm-api/x')).toBe(true);
    Rotation.maybeResetSessionSkippedModelsAfterFixIteration(stateContext, 2);
    expect(ensureRotationSession(stateContext).skippedModelKeys.size).toBe(0);
  });

  it('per-key: skip added at iteration K clears at K+N, not earlier', () => {
    vi.stubEnv('PRR_SESSION_MODEL_SKIP_RESET_AFTER_FIX_ITERATIONS', '2');
    vi.stubEnv('PRR_SESSION_MODEL_SKIP_FAILURES', '1');
    const stateContext = createStateContext('/tmp/w');
    Rotation.recordSessionModelVerificationOutcome(stateContext, 'llm-api', 'bad/model', 0, 1, 3);
    expect(ensureRotationSession(stateContext).skippedModelKeys.has('llm-api/bad/model')).toBe(true);
    Rotation.maybeResetSessionSkippedModelsAfterFixIteration(stateContext, 4);
    expect(ensureRotationSession(stateContext).skippedModelKeys.has('llm-api/bad/model')).toBe(true);
    Rotation.maybeResetSessionSkippedModelsAfterFixIteration(stateContext, 5);
    expect(ensureRotationSession(stateContext).skippedModelKeys.has('llm-api/bad/model')).toBe(false);
  });

  it('does nothing when env unset or iteration not on boundary', () => {
    const stateContext = createStateContext('/tmp/w');
    ensureRotationSession(stateContext).skippedModelKeys.add('llm-api/x');
    Rotation.maybeResetSessionSkippedModelsAfterFixIteration(stateContext, 3);
    expect(ensureRotationSession(stateContext).skippedModelKeys.size).toBe(1);
  });
});
