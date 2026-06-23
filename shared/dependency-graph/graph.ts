/**
 * Build a best-effort file dependency graph and compute blast radius (BFS + proximity union).
 *
 * **WHY async file reads in `buildDependencyGraph`:** Source bodies are read with `fs/promises`;
 * specifier → path mapping is async in `specifier-resolver.ts` so probe storms do not block the
 * event loop (see that module’s header).
 *
 * **WHY index-based BFS queue:** `Array.shift()` is O(n) per dequeue; large frontiers made radius
 * computation quadratic in queue length. Cursor + `push` keeps dequeue O(1).
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';
import { join } from 'path';

import { detectDepScanLang, extractImports } from './import-scanner.js';
import { resolveSpecifier, type LangContext } from './specifier-resolver.js';
import { getDirectoryNeighbors, getFilenamePatternMatches } from './proximity.js';

const execFileAsync = promisify(execFile);

export interface FileDepGraph {
  imports: Map<string, Set<string>>;
  importedBy: Map<string, Set<string>>;
  nodeCount: number;
  edgeCount: number;
}

export interface BuildDependencyGraphOptions {
  /** Max source files to scan (default from env or 5000). */
  maxFiles?: number;
  timeoutMs?: number;
  /** Override file list (tests); otherwise `git ls-files`. */
  fileList?: string[];
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw == null || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function isBlastRadiusDisabled(): boolean {
  const v = process.env.PRR_DISABLE_BLAST_RADIUS?.trim();
  return v === '1' || /^true$/i.test(v ?? '');
}

export function getBlastRadiusDepth(): number {
  return envInt('PRR_BLAST_RADIUS_DEPTH', 2);
}

export function getBlastRadiusMaxFiles(): number {
  return envInt('PRR_BLAST_RADIUS_MAX_FILES', 5000);
}

export function getBlastRadiusTimeoutMs(): number {
  return envInt('PRR_BLAST_RADIUS_TIMEOUT_MS', 30_000);
}

export function isBlastRadiusDismissEnabled(): boolean {
  const v = process.env.PRR_BLAST_RADIUS_DISMISS?.trim();
  return v === '1' || /^true$/i.test(v ?? '');
}

/** Tracked repo paths (git output uses `/`). */
export async function listGitTrackedFiles(workdir: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['ls-files'], {
    cwd: workdir,
    maxBuffer: 50 * 1024 * 1024,
    encoding: 'utf8',
  });
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function addEdge(imports: Map<string, Set<string>>, importedBy: Map<string, Set<string>>, from: string, to: string): void {
  if (from === to) return;
  if (!imports.has(from)) imports.set(from, new Set());
  if (!importedBy.has(to)) importedBy.set(to, new Set());
  imports.get(from)!.add(to);
  importedBy.get(to)!.add(from);
}

/**
 * Scan tracked source files and resolve import edges (best-effort).
 */
export async function buildDependencyGraph(
  workdir: string,
  options?: BuildDependencyGraphOptions
): Promise<FileDepGraph> {
  const maxFiles = options?.maxFiles ?? getBlastRadiusMaxFiles();
  const timeoutMs = options?.timeoutMs ?? getBlastRadiusTimeoutMs();
  const started = Date.now();

  const allRel = options?.fileList ?? (await listGitTrackedFiles(workdir));
  const toScan = allRel.filter((p) => detectDepScanLang(p) != null);
  if (toScan.length > maxFiles) {
    throw new Error(
      `blast-radius: ${toScan.length} source files exceeds PRR_BLAST_RADIUS_MAX_FILES (${maxFiles})`
    );
  }

  const imports = new Map<string, Set<string>>();
  const importedBy = new Map<string, Set<string>>();
  const ctx: LangContext = {};

  for (const rel of toScan) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`blast-radius: build exceeded timeout (${timeoutMs}ms)`);
    }
    const lang = detectDepScanLang(rel)!;
    let content: string;
    try {
      content = await readFile(join(workdir, rel), 'utf8');
    } catch {
      continue;
    }
    const specs = extractImports(rel, content);
    for (const spec of specs) {
      const target = await resolveSpecifier(spec, rel, lang, workdir, ctx);
      if (target) addEdge(imports, importedBy, rel, target);
    }
  }

  const nodes = new Set<string>([...imports.keys(), ...importedBy.keys()]);
  let edgeCount = 0;
  for (const s of imports.values()) edgeCount += s.size;

  return {
    imports,
    importedBy,
    nodeCount: nodes.size,
    edgeCount,
  };
}

/**
 * BFS from seeds over imports ∪ importedBy, depth-limited; union directory + filename proximity at depth 1.
 *
 * **WHY bidirectional edges:** Review comments may sit on a callee while the PR changed the caller
 * (or the reverse); traversing both `imports` and `importedBy` keeps related files within `maxDepth`.
 *
 * **WHY merge proximity after BFS:** Regex edges miss co-located tests and style modules; directory
 * and stem heuristics add depth-1 candidates without parsing each language’s test conventions.
 */
export function computeBlastRadius(
  graph: FileDepGraph,
  seedFiles: string[],
  maxDepth: number,
  allTrackedFiles?: string[]
): Map<string, number> {
  const { imports, importedBy } = graph;
  const dist = new Map<string, number>();
  const q: string[] = [];
  /** Head index — avoid `shift()` reallocating the whole queue each step. */
  let qi = 0;

  for (const s of seedFiles) {
    if (!dist.has(s)) {
      dist.set(s, 0);
      q.push(s);
    }
  }

  while (qi < q.length) {
    const u = q[qi++]!;
    const d = dist.get(u)!;
    if (d >= maxDepth) continue;
    const nextD = d + 1;
    const neigh = [...(imports.get(u) ?? []), ...(importedBy.get(u) ?? [])];
    for (const v of neigh) {
      const prev = dist.get(v);
      if (prev === undefined || nextD < prev) {
        dist.set(v, nextD);
        q.push(v);
      }
    }
  }

  if (allTrackedFiles && allTrackedFiles.length > 0) {
    const dirProx = getDirectoryNeighbors(seedFiles, allTrackedFiles);
    const nameProx = getFilenamePatternMatches(seedFiles, allTrackedFiles);
    for (const m of [dirProx, nameProx]) {
      for (const [path, depth] of m) {
        const cur = dist.get(path);
        if (cur === undefined || depth < cur) dist.set(path, depth);
      }
    }
  }

  return dist;
}

export function isInBlastRadius(repoRelativePath: string, radiusMap: Map<string, number>): boolean {
  return radiusMap.has(repoRelativePath);
}
