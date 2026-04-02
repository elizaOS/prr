/**
 * Rewrite plan: developer-editable format describing per-split git ops (cherry-pick or commit-from-sha).
 * WHY separate from parse-plan: Group plan (.split-plan.md) vs rewrite plan (.split-rewrite-plan.md/.yaml) are different artifacts; parser is forgiving for human/LLM edits.
 */
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { parse as parseYaml } from 'yaml';
import { assertValidGitBranchName } from './parse-plan.js';

/**
 * Single operation in a split's sequence.
 * WHY discriminated union: Executor switches on op.type; cherry-pick has no paths, commit-from-sha requires non-empty paths.
 */
export type RewritePlanOp =
  | { type: 'cherry-pick'; sha: string }
  | { type: 'commit-from-sha'; sha: string; paths: string[]; message?: string };

export interface RewritePlanSplit {
  branchName: string;
  splitIndex: number;
  ops: RewritePlanOp[];
}

export interface RewritePlan {
  source_branch: string;
  source_tip_sha: string;
  target_branch: string;
  /** ISO timestamp when the plan was generated. WHY: Lets users see plan age; executor uses source_tip_sha for staleness check. */
  generated_at: string;
  splits: RewritePlanSplit[];
}

const COMMIT_SHA_REGEX = /^[0-9a-f]{7,40}$/i;

function isValidSha(sha: string): boolean {
  return typeof sha === 'string' && COMMIT_SHA_REGEX.test(sha.trim());
}

/** WHY: Developer-editable format may use comma-separated or list; we accept both and trim so parser is forgiving. */
function normalizePaths(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((p) => String(p).trim()).filter(Boolean);
  if (typeof v === 'string') return v.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean);
  return [];
}

function parseOp(raw: unknown): RewritePlanOp {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid rewrite plan: op must be an object');
  const o = raw as Record<string, unknown>;
  const type = o.type;
  if (type === 'cherry-pick') {
    const sha = o.sha;
    if (!sha || !isValidSha(String(sha))) throw new Error('Invalid rewrite plan: cherry-pick op must have valid sha');
    return { type: 'cherry-pick', sha: String(sha).trim() };
  }
  if (type === 'commit-from-sha') {
    const sha = o.sha;
    if (!sha || !isValidSha(String(sha))) throw new Error('Invalid rewrite plan: commit-from-sha op must have valid sha');
    const paths = normalizePaths(o.paths);
    if (paths.length === 0) throw new Error('Invalid rewrite plan: commit-from-sha op must have non-empty paths'); // WHY: Empty paths would checkout nothing; executor would commit no change or wrong scope.
    return {
      type: 'commit-from-sha',
      sha: String(sha).trim(),
      paths,
      message: o.message != null ? String(o.message) : undefined,
    };
  }
  throw new Error(`Invalid rewrite plan: unknown op type "${type}"`);
}

function parseSplit(raw: unknown): RewritePlanSplit {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid rewrite plan: split must be an object');
  const s = raw as Record<string, unknown>;
  const branchName = s.branchName;
  const splitIndex = s.splitIndex;
  if (!branchName || typeof branchName !== 'string' || !branchName.trim())
    throw new Error('Invalid rewrite plan: split must have branchName');
  const idx = typeof splitIndex === 'number' ? splitIndex : parseInt(String(splitIndex ?? 1), 10);
  const opsRaw = s.ops;
  const ops: RewritePlanOp[] = Array.isArray(opsRaw)
    ? opsRaw.map((op, i) => {
        try {
          return parseOp(op);
        } catch (e) {
          throw new Error(`Invalid rewrite plan: split "${branchName}" op ${i}: ${e instanceof Error ? e.message : e}`);
        }
      })
    : [];
  const trimmedBranch = String(branchName).trim();
  assertValidGitBranchName(trimmedBranch, `rewrite plan split ${idx}`);
  return { branchName: trimmedBranch, splitIndex: idx, ops };
}

function parsePayload(data: Record<string, unknown>): RewritePlan {
  const source_branch = data.source_branch;
  const source_tip_sha = data.source_tip_sha;
  const target_branch = data.target_branch;
  const generated_at = data.generated_at;
  if (!source_branch || typeof source_branch !== 'string')
    throw new Error('Invalid rewrite plan: missing or invalid source_branch');
  if (!source_tip_sha || !isValidSha(String(source_tip_sha)))
    throw new Error('Invalid rewrite plan: missing or invalid source_tip_sha');
  if (!target_branch || typeof target_branch !== 'string')
    throw new Error('Invalid rewrite plan: missing or invalid target_branch');
  const splitsRaw = data.splits;
  if (!Array.isArray(splitsRaw)) throw new Error('Invalid rewrite plan: splits must be an array');
  const splits = splitsRaw.map((s, i) => {
    try {
      return parseSplit(s);
    } catch (e) {
      throw new Error(`Invalid rewrite plan: split ${i}: ${e instanceof Error ? e.message : e}`);
    }
  });
  const srcBranch = String(source_branch).trim();
  const tgtBranch = String(target_branch).trim();
  assertValidGitBranchName(srcBranch, 'rewrite plan source_branch');
  assertValidGitBranchName(tgtBranch, 'rewrite plan target_branch');
  return {
    source_branch: srcBranch,
    source_tip_sha: String(source_tip_sha).trim(),
    target_branch: tgtBranch,
    generated_at: generated_at != null ? String(generated_at) : '',
    splits,
  };
}

const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

/**
 * Parse a rewrite plan file (JSON, YAML, or Markdown with YAML frontmatter). Developer-editable; parser is forgiving (trim, normalize paths).
 * WHY .md: Plan format allows Markdown + YAML frontmatter; we extract the first --- block and parse as YAML.
 */
export function parseRewritePlanFile(path: string): RewritePlan {
  if (!existsSync(path)) throw new Error(`Rewrite plan file not found: ${path}`);
  const raw = readFileSync(path, 'utf-8');
  const trimmed = raw.trim();
  let data: Record<string, unknown>;
  if (path.endsWith('.json') || trimmed.startsWith('{')) {
    try {
      data = JSON.parse(trimmed) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`Invalid rewrite plan JSON in ${path}: ${e instanceof Error ? e.message : e}`);
    }
  } else if (path.endsWith('.md')) {
    const frontMatch = trimmed.match(FRONTMATTER_REGEX);
    const yamlBlock = frontMatch ? frontMatch[1] : trimmed;
    try {
      data = parseYaml(yamlBlock) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`Invalid rewrite plan (markdown frontmatter) in ${path}: ${e instanceof Error ? e.message : e}`);
    }
  } else {
    try {
      data = parseYaml(trimmed) as Record<string, unknown>;
    } catch (e) {
      throw new Error(`Invalid rewrite plan YAML in ${path}: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (!data || typeof data !== 'object') throw new Error(`Invalid rewrite plan: root must be an object in ${path}`);
  return parsePayload(data);
}

/**
 * Resolve rewrite plan path: explicit path, or beside group plan as .split-rewrite-plan.md / .yaml / .json.
 * WHY beside group plan: Common workflow is "split-rewrite-plan then split-exec" in the same dir; one plan file next to the other keeps paths simple.
 */
export function resolveRewritePlanPath(groupPlanPath: string, explicitPath?: string): string | null {
  if (explicitPath?.trim()) return explicitPath.trim();
  const dir = dirname(groupPlanPath);
  const candidates = [
    join(dir, '.split-rewrite-plan.md'),
    join(dir, '.split-rewrite-plan.yaml'),
    join(dir, '.split-rewrite-plan.yml'),
    join(dir, '.split-rewrite-plan.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}
