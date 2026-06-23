/**
 * Map raw import specifiers to repo-relative paths (best-effort).
 *
 * **WHY null:** External packages, angle includes, or ambiguous specifiers are skipped; missing
 * edges keep blast radius conservative (smaller), not wrong-file edits.
 *
 * **WHY async:** Graph build walks thousands of specifiers; sync `existsSync` / `readFileSync`
 * block the event loop. `fs/promises` keeps PRR responsive to signals and concurrent work.
 */

import { constants } from 'fs';
import { access, readFile, readdir, stat } from 'fs/promises';
import { dirname, join, normalize, posix, relative, sep } from 'path';

import type { DepScanLang } from './import-scanner.js';

export interface LangContext {
  /** First line of go.mod: module example.com/foo */
  goModulePath?: string;
  /** Repo-relative dirs containing Java/Kotlin sources (e.g. src/main/java). */
  javaStyleRoots?: string[];
}

const TS_PROBE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

async function fileExistsUnderWorkdir(workdir: string, rel: string): Promise<boolean> {
  const n = normalize(join(workdir, rel));
  if (!n.startsWith(normalize(workdir + sep))) return false;
  try {
    await access(n, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function tryProbeExtensions(workdir: string, baseRel: string, exts: string[]): Promise<string | null> {
  const clean = baseRel.replace(/\/$/, '');
  for (const ext of exts) {
    const p = clean + ext;
    if (await fileExistsUnderWorkdir(workdir, p)) return toPosix(p);
  }
  for (const ext of exts) {
    const idx = clean + `/index${ext}`;
    if (await fileExistsUnderWorkdir(workdir, idx)) return toPosix(idx);
  }
  return null;
}

async function resolveTsLikeSpecifier(spec: string, fromFile: string, workdir: string): Promise<string | null> {
  if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
  const fromDir = dirname(fromFile);
  const joined = normalize(join(fromDir, spec));
  const rel = relative(workdir, join(workdir, joined));
  if (rel.startsWith('..')) return null;
  const relPosix = toPosix(rel);
  return tryProbeExtensions(workdir, relPosix, TS_PROBE_EXT);
}

async function parseGoModulePath(workdir: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(workdir, 'go.mod'), 'utf8');
    const m = /^\s*module\s+(\S+)/m.exec(raw);
    return m?.[1];
  } catch {
    return undefined;
  }
}

async function discoverJavaStyleRoots(workdir: string): Promise<string[]> {
  const roots: string[] = [];
  const candidates = [
    'src/main/java',
    'src/main/kotlin',
    'src/test/java',
    'src/test/kotlin',
    'app/src/main/java',
    'app/src/main/kotlin',
    'src',
  ];
  for (const c of candidates) {
    try {
      const s = await stat(join(workdir, c));
      if (s.isDirectory()) roots.push(c);
    } catch {
      /* not present */
    }
  }
  return [...new Set(roots)];
}

async function resolveGoSpecifier(spec: string, workdir: string, ctx: LangContext): Promise<string | null> {
  if (!spec.includes('/')) return null;
  const mod = ctx.goModulePath;
  if (!mod) return null;
  let packageDir: string;
  if (spec === mod) {
    packageDir = '.';
  } else if (spec.startsWith(mod + '/')) {
    packageDir = spec.slice(mod.length + 1);
  } else {
    return null;
  }
  const absDir = packageDir === '.' ? workdir : join(workdir, packageDir);
  try {
    const names = await readdir(absDir, { withFileTypes: true });
    const goFiles = names.filter((d) => d.isFile() && d.name.endsWith('.go')).map((d) => d.name);
    if (goFiles.length === 0) return null;
    goFiles.sort();
    const fileRel = packageDir === '.' ? goFiles[0]! : join(packageDir, goFiles[0]!);
    return toPosix(fileRel);
  } catch {
    return null;
  }
}

async function resolvePythonSpecifier(spec: string, fromFile: string, workdir: string): Promise<string | null> {
  const fromDir = dirname(fromFile);
  let up = 0;
  let rest = spec;
  while (rest.startsWith('.')) {
    up++;
    rest = rest.slice(1);
  }
  let baseDir = fromDir;
  for (let i = 1; i < up; i++) {
    const next = dirname(baseDir);
    if (next === baseDir) break;
    baseDir = next;
  }
  const parts = rest.split('.').filter(Boolean);
  if (parts.length === 0) return null;
  const subPath = parts.join('/');
  if (up > 0) {
    const candidatePy = join(baseDir, subPath + '.py');
    const relPy = relative(workdir, join(workdir, candidatePy));
    if (!relPy.startsWith('..') && (await fileExistsUnderWorkdir(workdir, relPy))) return toPosix(relPy);
    const initPath = join(baseDir, subPath, '__init__.py');
    const relInit = relative(workdir, join(workdir, initPath));
    if (!relInit.startsWith('..') && (await fileExistsUnderWorkdir(workdir, relInit))) return toPosix(relInit);
    return null;
  }
  const absPath = join(subPath + '.py');
  if (await fileExistsUnderWorkdir(workdir, absPath)) return toPosix(absPath);
  const pkgInit = join(subPath, '__init__.py');
  if (await fileExistsUnderWorkdir(workdir, pkgInit)) return toPosix(pkgInit);
  return null;
}

async function resolveRustMod(spec: string, fromFile: string, workdir: string): Promise<string | null> {
  const fromDir = dirname(fromFile);
  const f1 = join(fromDir, spec + '.rs');
  const r1 = relative(workdir, join(workdir, f1));
  if (!r1.startsWith('..') && (await fileExistsUnderWorkdir(workdir, r1))) return toPosix(r1);
  const f2 = join(fromDir, spec, 'mod.rs');
  const r2 = relative(workdir, join(workdir, f2));
  if (!r2.startsWith('..') && (await fileExistsUnderWorkdir(workdir, r2))) return toPosix(r2);
  return null;
}

async function resolveCInclude(spec: string, fromFile: string, workdir: string): Promise<string | null> {
  const fromDir = dirname(fromFile);
  const candidates = [
    join(fromDir, spec),
    spec,
    join('include', spec),
    join('src', spec),
  ];
  for (const c of candidates) {
    const r = relative(workdir, join(workdir, c));
    if (!r.startsWith('..') && (await fileExistsUnderWorkdir(workdir, r))) return toPosix(r);
  }
  return null;
}

async function resolveJavaLikeImport(spec: string, workdir: string, ctx: LangContext, ext: string): Promise<string | null> {
  if (spec.endsWith('.*')) return null;
  const pathPart = spec.replace(/\./g, '/') + ext;
  const roots = ctx.javaStyleRoots ?? (await discoverJavaStyleRoots(workdir));
  ctx.javaStyleRoots = roots;
  for (const root of roots) {
    const rel = join(root, pathPart);
    if (await fileExistsUnderWorkdir(workdir, rel)) return toPosix(rel);
  }
  return null;
}

async function resolveRubySpecifier(spec: string, fromFile: string, workdir: string): Promise<string | null> {
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const fromDir = dirname(fromFile);
    const joined = normalize(join(fromDir, spec));
    const rel = relative(workdir, join(workdir, joined));
    if (rel.startsWith('..')) return null;
    const base = rel.endsWith('.rb') ? rel : rel + '.rb';
    if (await fileExistsUnderWorkdir(workdir, base)) return toPosix(base);
    return null;
  }
  const libPath = join('lib', spec.replace(/\//g, posix.sep) + '.rb');
  if (await fileExistsUnderWorkdir(workdir, libPath)) return toPosix(libPath);
  return null;
}

async function resolvePhpSpecifier(spec: string, fromFile: string, workdir: string): Promise<string | null> {
  const fromDir = dirname(fromFile);
  if (spec.startsWith('./') || spec.startsWith('../')) {
    const joined = normalize(join(fromDir, spec));
    const rel = relative(workdir, join(workdir, joined));
    if (!rel.startsWith('..') && (await fileExistsUnderWorkdir(workdir, rel))) return toPosix(rel);
    return null;
  }
  if (await fileExistsUnderWorkdir(workdir, spec)) return toPosix(spec);
  return null;
}

/**
 * Resolve one specifier to a single tracked-style repo-relative path, or null.
 */
export async function resolveSpecifier(
  specifier: string,
  fromFilePath: string,
  lang: DepScanLang,
  workdir: string,
  ctx: LangContext
): Promise<string | null> {
  const spec = specifier.trim();
  if (!spec) return null;

  switch (lang) {
    case 'ts':
      return resolveTsLikeSpecifier(spec, fromFilePath, workdir);
    case 'python':
      return resolvePythonSpecifier(spec, fromFilePath, workdir);
    case 'go': {
      if (!ctx.goModulePath) ctx.goModulePath = await parseGoModulePath(workdir);
      return resolveGoSpecifier(spec, workdir, ctx);
    }
    case 'rust':
      return resolveRustMod(spec, fromFilePath, workdir);
    case 'c':
      return resolveCInclude(spec, fromFilePath, workdir);
    case 'java':
      return resolveJavaLikeImport(spec, workdir, ctx, '.java');
    case 'kotlin':
      return (await resolveJavaLikeImport(spec, workdir, ctx, '.kt')) ?? (await resolveJavaLikeImport(spec, workdir, ctx, '.kts'));
    case 'ruby':
      return resolveRubySpecifier(spec, fromFilePath, workdir);
    case 'php':
      return resolvePhpSpecifier(spec, fromFilePath, workdir);
    default:
      return null;
  }
}
