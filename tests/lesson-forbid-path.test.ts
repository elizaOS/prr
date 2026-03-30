import { describe, it, expect } from 'vitest';
import {
  lessonForbidsEditingIssuePath,
  getLessonsForIssue,
} from '../tools/prr/state/lessons-retrieve.js';
import { pruneLessonsForbiddingOwnTargetPath } from '../tools/prr/state/lessons-prune.js';
import { createLessonsContext } from '../tools/prr/state/lessons-context.js';

describe('lessonForbidsEditingIssuePath', () => {
  it('is true when the only path in the lesson is the issue path and text forbids edit', () => {
    expect(
      lessonForbidsEditingIssuePath(
        "Do NOT edit benchmarks/bfcl/reporting.py — wrong file; fix is elsewhere.",
        'benchmarks/bfcl/reporting.py',
      ),
    ).toBe(true);
  });

  it('is false when the lesson forbids a different path than the issue', () => {
    expect(
      lessonForbidsEditingIssuePath(
        "Don't edit `src/bar.ts`; the bug is in `src/foo.ts`.",
        'src/foo.ts',
      ),
    ).toBe(false);
  });

  it('is false for multi-path lesson that redirects edit to the issue path', () => {
    expect(
      lessonForbidsEditingIssuePath(
        "Don't edit `wrong/legacy.ts`; instead edit `src/fix.ts` for the handler.",
        'src/fix.ts',
      ),
    ).toBe(false);
  });

  it('is false when there is no forbid phrase', () => {
    expect(
      lessonForbidsEditingIssuePath('Edit `app/main.ts` to add logging.', 'app/main.ts'),
    ).toBe(false);
  });
});

describe('getLessonsForIssue + forbid filter', () => {
  it('drops a file-scoped lesson that forbids editing the issue file', () => {
    const ctx = createLessonsContext('o', 'r', 'b', '/tmp/.prr-lessons.json');
    ctx.store.files['pkg/x.ts'] = ["Don't edit `pkg/x.ts` — use the shared util instead."];
    const out = getLessonsForIssue(ctx, 'pkg/x.ts', 'fix the bug', []);
    expect(out).toHaveLength(0);
  });
});

describe('pruneLessonsForbiddingOwnTargetPath', () => {
  it('removes lessons under a file key that forbid editing that file', () => {
    const ctx = createLessonsContext('o', 'r', 'b', '/tmp/.prr-lessons.json');
    ctx.store.files['a/b.py'] = ["Do not modify `a/b.py` — wrong target file."];
    const n = pruneLessonsForbiddingOwnTargetPath(ctx);
    expect(n).toBe(1);
    expect(ctx.store.files['a/b.py']).toBeUndefined();
    expect(ctx.dirty).toBe(true);
  });
});
