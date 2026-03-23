/**
 * Machine-readable provider model catalog (generated/model-provider-catalog.json).
 * WHY: Review bots often lag vendor renames (e.g. gpt-5-mini vs gpt4-mini); PRR and
 * other tools can treat catalog IDs as authoritative spellings.
 *
 * Refresh: npm run update-model-catalog (recommended weekly; see fetchedAtIso in JSON).
 */
import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ModelProviderCatalog {
  schemaVersion: 1;
  fetchedAtIso: string;
  recommendedRefreshDays: number;
  sources: Array<{
    name: 'anthropic' | 'openai';
    url: string;
    ok: boolean;
    httpStatus: number;
    error?: string;
    idCount: number;
  }>;
  providers: {
    anthropic: { apiIds: string[] };
    openai: { apiIds: string[] };
  };
  lookup: {
    openaiHyphenless: Record<string, string>;
    anthropicHyphenless: Record<string, string>;
    ambiguousHyphenless: string[];
  };
}

let cached: ModelProviderCatalog | null = null;
let cachedPath: string | null = null;

/** In-memory fallback when the JSON is missing, unreadable, or invalid. Never cached as a successful load. */
export const EMPTY_MODEL_PROVIDER_CATALOG: ModelProviderCatalog = {
  schemaVersion: 1,
  fetchedAtIso: '',
  recommendedRefreshDays: 7,
  sources: [],
  providers: {
    anthropic: { apiIds: [] },
    openai: { apiIds: [] },
  },
  lookup: {
    openaiHyphenless: {},
    anthropicHyphenless: {},
    ambiguousHyphenless: [],
  },
};

const warnedCatalogPaths = new Set<string>();

function warnCatalogOnce(key: string, message: string): void {
  if (warnedCatalogPaths.has(key)) return;
  warnedCatalogPaths.add(key);
  console.warn(message);
}

function emptyCatalogFresh(): ModelProviderCatalog {
  return structuredClone(EMPTY_MODEL_PROVIDER_CATALOG);
}

/**
 * Resolve path to generated/model-provider-catalog.json.
 * Walks up from this file so it works from source (`shared/`), `dist/shared/`, or other layouts.
 */
export function modelCatalogDefaultPath(): string {
  const env = process.env.PRR_MODEL_CATALOG_PATH?.trim();
  if (env) return env;
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'generated', 'model-provider-catalog.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(__dirname, '../../generated/model-provider-catalog.json');
}

export function loadModelProviderCatalog(path?: string): ModelProviderCatalog {
  const p = path ?? modelCatalogDefaultPath();
  if (cached && cachedPath === p) return cached;
  const warnKey = `load:${p}`;
  if (!existsSync(p)) {
    warnCatalogOnce(
      warnKey,
      `Model catalog not found at ${p} — catalog-based dismissal/auto-heal disabled until present. Run: npm run update-model-catalog`,
    );
    return emptyCatalogFresh();
  }
  let raw: string;
  try {
    raw = readFileSync(p, 'utf8');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warnCatalogOnce(warnKey, `Model catalog unreadable at ${p} (${msg}) — using empty catalog until fixed.`);
    return emptyCatalogFresh();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    warnCatalogOnce(warnKey, `Model catalog JSON parse failed at ${p} (${msg}) — using empty catalog until fixed.`);
    return emptyCatalogFresh();
  }
  const catalog = parsed as ModelProviderCatalog;
  if (catalog.schemaVersion !== 1) {
    warnCatalogOnce(
      warnKey,
      `Unsupported model catalog schemaVersion at ${p}: ${String((parsed as { schemaVersion?: unknown }).schemaVersion)} — using empty catalog.`,
    );
    return emptyCatalogFresh();
  }
  if (!catalog.providers?.openai?.apiIds || !catalog.providers?.anthropic?.apiIds) {
    warnCatalogOnce(warnKey, `Model catalog at ${p} is missing providers.openai/apiIds or providers.anthropic/apiIds — using empty catalog.`);
    return emptyCatalogFresh();
  }
  if (!catalog.lookup?.openaiHyphenless || !catalog.lookup?.anthropicHyphenless || !Array.isArray(catalog.lookup?.ambiguousHyphenless)) {
    warnCatalogOnce(warnKey, `Model catalog at ${p} is missing lookup tables — using empty catalog.`);
    return emptyCatalogFresh();
  }
  cached = catalog;
  cachedPath = p;
  return catalog;
}

/** Clear in-process cache (e.g. tests). */
export function resetModelProviderCatalogCache(): void {
  cached = null;
  cachedPath = null;
  warnedCatalogPaths.clear();
}

export function modelCatalogAgeMs(catalog: ModelProviderCatalog): number {
  const t = Date.parse(catalog.fetchedAtIso);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return Date.now() - t;
}

export function isModelCatalogStale(
  catalog: ModelProviderCatalog,
  maxDays: number = catalog.recommendedRefreshDays,
): boolean {
  const ms = maxDays * 86_400_000;
  return modelCatalogAgeMs(catalog) > ms;
}

function stripProviderPrefix(id: string): { provider?: 'openai' | 'anthropic'; rest: string } {
  const s = id.trim();
  const lo = s.toLowerCase();
  if (lo.startsWith('openai/')) return { provider: 'openai', rest: s.slice('openai/'.length).trim() };
  if (lo.startsWith('anthropic/')) return { provider: 'anthropic', rest: s.slice('anthropic/'.length).trim() };
  return { rest: s };
}

function hyphenlessKey(id: string): string {
  return id.toLowerCase().replace(/_/g, '-').replace(/-/g, '');
}

function catalogMatchesProvider(
  catalog: ModelProviderCatalog,
  p: 'openai' | 'anthropic',
  raw: string,
): { canonicalId: string; match: 'exact' | 'hyphenless' } | null {
  const { provider: hint, rest } = stripProviderPrefix(raw);
  if (hint !== undefined && hint !== p) return null;
  if (!rest) return null;
  const lower = rest.replace(/_/g, '-').toLowerCase();
  const ids = p === 'openai' ? catalog.providers.openai.apiIds : catalog.providers.anthropic.apiIds;
  const map = p === 'openai' ? catalog.lookup.openaiHyphenless : catalog.lookup.anthropicHyphenless;
  const exact = ids.find((x) => x.toLowerCase() === lower);
  if (exact) return { canonicalId: exact, match: 'exact' };
  const hl = hyphenlessKey(lower);
  if (catalog.lookup.ambiguousHyphenless.includes(hl)) return null;
  const canon = map[hl];
  if (canon) return { canonicalId: canon, match: 'hyphenless' };
  return null;
}

/**
 * Resolve a loose model string to a canonical API id when it matches the catalog.
 * Accepts optional openai/ or anthropic/ prefix; hyphen-insensitive when unambiguous.
 */
export function resolveCatalogModelId(loose: string): {
  provider: 'openai' | 'anthropic';
  canonicalId: string;
  match: 'exact' | 'hyphenless';
} | null {
  let catalog: ModelProviderCatalog;
  try {
    catalog = loadModelProviderCatalog();
  } catch {
    return null;
  }

  const { provider: hint } = stripProviderPrefix(loose);
  if (hint === 'openai') {
    const m = catalogMatchesProvider(catalog, 'openai', loose);
    return m ? { provider: 'openai', ...m } : null;
  }
  if (hint === 'anthropic') {
    const m = catalogMatchesProvider(catalog, 'anthropic', loose);
    return m ? { provider: 'anthropic', ...m } : null;
  }

  const o = catalogMatchesProvider(catalog, 'openai', loose);
  if (o) return { provider: 'openai', ...o };
  const a = catalogMatchesProvider(catalog, 'anthropic', loose);
  return a ? { provider: 'anthropic', ...a } : null;
}

export function isKnownOpenAiModelId(id: string): boolean {
  try {
    return catalogMatchesProvider(loadModelProviderCatalog(), 'openai', id) !== null;
  } catch {
    return false;
  }
}

export function isKnownAnthropicModelId(id: string): boolean {
  try {
    return catalogMatchesProvider(loadModelProviderCatalog(), 'anthropic', id) !== null;
  } catch {
    return false;
  }
}
