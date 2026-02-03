import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LessonsManager } from '../src/state/lessons.js';

async function run(): Promise<void> {
  const workdir = await mkdtemp(join(tmpdir(), 'prr-lessons-test-'));
  await mkdir(join(workdir, '.prr'), { recursive: true });

  const corruptedLessons = `# PRR Lessons Learned

## Global Lessons
- Fix for src/resolver.ts:null - (inferred) : string;
  private isShuttingDown = false;
  // Bail-out tracking: detect stalemates where no progress is made
- claude-code with claude-sonnet-4-5-20250929 made no changes - trying different approach

## File-Specific Lessons
### src/state/manager.ts:117 - (inferred) ts
- Fix for src/state/manager.ts:117 - (inferred) ts:117 - (inferred) - codex with gpt-5-mini made no changes: (inferred) Do NOT repeat them:
`;

  const lessonsPath = join(workdir, '.prr', 'lessons.md');
  await writeFile(lessonsPath, corruptedLessons, 'utf-8');

  const manager = new LessonsManager('test-owner', 'test-repo', 'test-branch');
  manager.setWorkdir(workdir);
  await manager.load();
  await manager.saveToRepo();

  const saved = await readFile(lessonsPath, 'utf-8');

  assert.ok(!saved.includes('private isShuttingDown'));
  assert.ok(!saved.includes('// Bail-out tracking'));
  assert.ok(!saved.includes('**Issues'));
  assert.ok(saved.includes('### src/state/manager.ts:117'));
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
