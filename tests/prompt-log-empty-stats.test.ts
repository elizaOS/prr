import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  initOutputLog,
  closeOutputLog,
  debugPrompt,
  debugResponse,
  getEmptyPromptBodyRejectionStats,
  getOutputLogPath,
} from '../shared/logger.js';

/**
 * Pill-output audit: per kind:slug counts + closeOutputLog summary on output.log.
 * WHY isolated PRR_LOG_DIR: avoids touching repo-root output.log; restores console after.
 */
describe('getEmptyPromptBodyRejectionStats / closeOutputLog empty-body summary', () => {
  const savedConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  let logDir: string;

  beforeAll(() => {
    logDir = mkdtempSync(join(tmpdir(), 'prr-logger-empty-'));
    process.env.PRR_LOG_DIR = logDir;
  });

  afterAll(async () => {
    delete process.env.PRR_LOG_DIR;
    console.log = savedConsole.log;
    console.warn = savedConsole.warn;
    console.error = savedConsole.error;
    try {
      rmSync(logDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('tracks PROMPT and RESPONSE refusals by kind:slug and writes breakdown to output.log on close', async () => {
    initOutputLog({ prefix: 'vitest-empty-stats' });
    const slugP = debugPrompt('test-label', '');
    expect(slugP).toMatch(/^#\d{4}\//);

    let stats = getEmptyPromptBodyRejectionStats();
    expect(stats.total).toBe(1);
    expect(stats.byKindSlug).toHaveLength(1);
    expect(stats.byKindSlug[0]?.key.startsWith('PROMPT:')).toBe(true);
    expect(stats.byKindSlug[0]?.count).toBe(1);

    debugResponse(slugP, 'test-label', '   ');
    stats = getEmptyPromptBodyRejectionStats();
    expect(stats.total).toBe(2);
    expect(stats.byKindSlug.length).toBeGreaterThanOrEqual(2);

    await closeOutputLog();

    stats = getEmptyPromptBodyRejectionStats();
    expect(stats.total).toBe(0);
    expect(stats.byKindSlug).toHaveLength(0);

    const outPath = getOutputLogPath();
    expect(outPath).toBeTruthy();
    const text = readFileSync(outPath!, 'utf8');
    expect(text).toContain('By kind:slug');
    expect(text).toContain('PROMPT:');
    expect(text).toContain('RESPONSE:');
  });
});
