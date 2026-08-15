import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, expect, test } from 'vitest';

import { extractImports, detectDepScanLang } from '../shared/dependency-graph/import-scanner.js';
import { resolveSpecifier, type LangContext } from '../shared/dependency-graph/specifier-resolver.js';
import {
  getDirectoryNeighbors,
  getFilenamePatternMatches,
} from '../shared/dependency-graph/proximity.js';
import {
  buildDependencyGraph,
  computeBlastRadius,
  isInBlastRadius,
} from '../shared/dependency-graph/graph.js';

async function tempWorkdir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'prr-depgraph-'));
}

describe('import-scanner', () => {
  test('detectDepScanLang', () => {
    expect(detectDepScanLang('x.ts')).toBe('ts');
    expect(detectDepScanLang('x.tsx')).toBe('ts');
    expect(detectDepScanLang('x.py')).toBe('python');
    expect(detectDepScanLang('x.go')).toBe('go');
    expect(detectDepScanLang('x.rs')).toBe('rust');
    expect(detectDepScanLang('x.java')).toBe('java');
    expect(detectDepScanLang('x.kt')).toBe('kotlin');
    expect(detectDepScanLang('x.rb')).toBe('ruby');
    expect(detectDepScanLang('x.php')).toBe('php');
    expect(detectDepScanLang('README.md')).toBeNull();
  });

  test('extractImports TS multi-line destructured', () => {
    const src = `import {
  foo,
  bar,
} from './utils';
import './side.css';
`;
    expect(extractImports('m.ts', src).sort()).toEqual(['./utils', './side.css'].sort());
  });

  test('extractImports Go import block', () => {
    const src = `package main
import (
  "fmt"
  x "github.com/foo/bar"
)
`;
    const specs = extractImports('m.go', src);
    expect(specs).toContain('fmt');
    expect(specs).toContain('github.com/foo/bar');
  });

  test('extractImports Python', () => {
    const src = 'import os\nfrom .utils import x\n';
    const specs = extractImports('m.py', src);
    expect(specs).toContain('os');
    expect(specs.some((s) => s.includes('utils'))).toBe(true);
  });
});

describe('specifier-resolver', () => {
  test('resolve TS relative', async () => {
    const workdir = await tempWorkdir();
    await writeFile(join(workdir, 'a.ts'), '');
    await writeFile(join(workdir, 'b.ts'), '');
    const ctx: LangContext = {};
    expect(await resolveSpecifier('./b', 'a.ts', 'ts', workdir, ctx)).toBe('b.ts');
  });

  test('resolve Rust mod', async () => {
    const workdir = await tempWorkdir();
    await mkdir(join(workdir, 'src'), { recursive: true });
    await writeFile(join(workdir, 'src', 'lib.rs'), '');
    await writeFile(join(workdir, 'src', 'foo.rs'), '');
    const ctx: LangContext = {};
    expect(await resolveSpecifier('foo', 'src/lib.rs', 'rust', workdir, ctx)).toBe('src/foo.rs');
  });
});

describe('proximity', () => {
  test('getDirectoryNeighbors respects cap', () => {
    const seeds = ['src/a.ts'];
    const many = ['src/a.ts', ...Array.from({ length: 40 }, (_, i) => `src/f${i}.ts`)];
    const m = getDirectoryNeighbors(seeds, many, 30);
    expect(m.size).toBe(0);
  });

  test('getFilenamePatternMatches links test file', () => {
    const seeds = ['components/Button.tsx'];
    const all = ['components/Button.tsx', 'components/Button.test.tsx', 'components/Other.tsx'];
    const m = getFilenamePatternMatches(seeds, all);
    expect(m.has('components/Button.test.tsx')).toBe(true);
    expect(m.has('components/Other.tsx')).toBe(false);
  });
});

describe('graph', () => {
  test('buildDependencyGraph and computeBlastRadius', async () => {
    const workdir = await tempWorkdir();
    await writeFile(
      join(workdir, 'a.ts'),
      `import { x } from './b';
export { x } from './c';
`,
    );
    await writeFile(join(workdir, 'b.ts'), 'export const x = 1;\n');
    await writeFile(join(workdir, 'c.ts'), 'export const x = 1;\n');

    const graph = await buildDependencyGraph(workdir, {
      fileList: ['a.ts', 'b.ts', 'c.ts'],
      timeoutMs: 30_000,
      maxFiles: 5000,
    });
    expect(graph.edgeCount).toBeGreaterThanOrEqual(2);

    const radius = computeBlastRadius(graph, ['b.ts'], 2, ['a.ts', 'b.ts', 'c.ts']);
    expect(radius.get('b.ts')).toBe(0);
    expect(radius.get('a.ts')).toBeDefined();
    expect(isInBlastRadius('a.ts', radius)).toBe(true);
  });
});
