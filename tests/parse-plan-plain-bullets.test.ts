import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parsePlanFile } from '../tools/split-exec/parse-plan.js';

describe('parsePlanFile plain bullets', () => {
  it('parses **Files:** and **Commits:** without backticks on bullet lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'parse-plan-'));
    const planPath = join(dir, '.split-plan.md');
    const body = [
      '---',
      'source_pr: https://github.com/o/r/pull/1',
      'source_branch: feat',
      'target_branch: main',
      '---',
      '',
      '## Split',
      '',
      '### 1. One',
      '- **New PR:** `split-one`',
      '- **Files:**',
      '  - src/a.ts',
      '  - src/b.ts',
      '- **Commits:**',
      '  - abcdef1',
      '  - 2345678',
      '',
    ].join('\n');
    writeFileSync(planPath, body, 'utf-8');
    const p = parsePlanFile(planPath);
    rmSync(dir, { recursive: true, force: true });
    expect(p.splits).toHaveLength(1);
    expect(p.splits[0]!.files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(p.splits[0]!.commits).toEqual(['abcdef1', '2345678']);
  });
});
