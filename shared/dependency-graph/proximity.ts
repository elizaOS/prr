/**
 * Zero-parse proximity signals for blast radius: same-directory neighbors and filename conventions.
 *
 * **WHY:** Regex import graphs miss co-located tests, CSS modules, and stories; proximity pulls
 * them into scope without language-specific parsers.
 */

import { dirname, basename } from 'path';

/** Default cap so a flat `src/` does not add hundreds of files (plan: MAX_DIR_NEIGHBORS). */
export const DEFAULT_MAX_DIR_NEIGHBORS = 30;

function envMaxDirNeighbors(): number {
  const raw = process.env.PRR_BLAST_RADIUS_MAX_DIR_NEIGHBORS;
  if (raw == null || raw === '') return DEFAULT_MAX_DIR_NEIGHBORS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_DIR_NEIGHBORS;
}

/**
 * Files in the same directory as any seed file get depth 1, only if that directory has
 * at most `maxDirNeighbors` tracked files.
 */
export function getDirectoryNeighbors(
  seedFiles: string[],
  allFiles: string[],
  maxDirNeighbors: number = envMaxDirNeighbors()
): Map<string, number> {
  const out = new Map<string, number>();
  const byDir = new Map<string, string[]>();
  for (const f of allFiles) {
    const d = dirname(f);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d)!.push(f);
  }
  const seedDirs = new Set(seedFiles.map((f) => dirname(f)));
  for (const dir of seedDirs) {
    const neighbors = byDir.get(dir);
    if (!neighbors || neighbors.length > maxDirNeighbors) continue;
    for (const f of neighbors) {
      if (!out.has(f)) out.set(f, 1);
    }
  }
  return out;
}

const STRIP_SUFFIXES = [
  /\.test\.[^.]+$/i,
  /\.spec\.[^.]+$/i,
  /\.stories\.[^.]+$/i,
  /\.story\.[^.]+$/i,
  /\.module\.css$/i,
  /\.module\.scss$/i,
  /\.styles?\.[^.]+$/i,
  /-test\.[^.]+$/i,
  /_test\.[^.]+$/i,
  /\.mock\.[^.]+$/i,
  /\.fixture\.[^.]+$/i,
  /\.d\.ts$/i,
];

function stripKnownSuffixes(fileName: string): Set<string> {
  const bases = new Set<string>();
  bases.add(fileName);
  let current = fileName;
  for (let i = 0; i < 4; i++) {
    let changed = false;
    for (const re of STRIP_SUFFIXES) {
      const next = current.replace(re, '');
      if (next !== current && next.length > 0) {
        current = next;
        bases.add(current);
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  const dot = current.lastIndexOf('.');
  if (dot > 0) bases.add(current.slice(0, dot));
  return bases;
}

/**
 * Match files that share a stem with any seed (e.g. `Button.tsx` ↔ `Button.test.tsx`).
 */
export function getFilenamePatternMatches(seedFiles: string[], allFiles: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const seedSet = new Set(seedFiles);
  const stems = new Set<string>();
  for (const f of seedFiles) {
    const base = basename(f);
    for (const s of stripKnownSuffixes(base)) {
      stems.add(s);
    }
  }
  for (const f of allFiles) {
    if (seedSet.has(f)) continue;
    const base = basename(f);
    const fileStems = stripKnownSuffixes(base);
    for (const st of fileStems) {
      if (stems.has(st)) {
        out.set(f, 1);
        break;
      }
    }
  }
  return out;
}
