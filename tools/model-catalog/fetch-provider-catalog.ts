#!/usr/bin/env npx tsx
/**
 * Fetches official provider doc pages and extracts public model API IDs into
 * generated/model-provider-catalog.json for tools (e.g. PRR) to validate names.
 *
 * Sources are the same URLs documented in docs/MODELS.md (Claude overview,
 * OpenAI full catalog). Static HTML embeds enough IDs for regex extraction;
 * no provider API keys required.
 *
 * Run: npm run update-model-catalog
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '../..');
const OUT_PATH = join(REPO_ROOT, 'generated/model-provider-catalog.json');

const UA = 'prr-model-catalog/1.0 (+https://github.com)';

const SOURCES = {
  anthropic: {
    name: 'anthropic' as const,
    url: 'https://platform.claude.com/docs/en/about-claude/models/overview',
  },
  openai: {
    name: 'openai' as const,
    /** Full catalog page (static HTML includes model slugs). */
    url: 'https://developers.openai.com/api/docs/models/all',
  },
};

const CLAUDE_NOISE =
  /foundry|bedrock|vertex|analytics|practices|features|microsoft|amazon|prompting|in-microsoft|on-amazon|on-vertex|^claude-code|claude-ui/i;

/** Fragments pulled from longer slugs / nav — not standalone API IDs. */
const OPENAI_DROP = new Set([
  'gpt-ui',
  'gpt-oss',
  'chatgpt',
  'chatgpt-ui',
  'codex-mini',
  'omni-moderation',
  'gpt-3',
  'gpt-3.5',
  'gpt-4.5',
]);

function stripTrailingVersionSuffix(id: string): string {
  return id.replace(/-v\d+$/i, '').replace(/-v\d+:\d+$/i, '');
}

function extractAnthropicIds(html: string): string[] {
  const re = /\bclaude-(?:3-)?(?:opus|sonnet|haiku)[a-z0-9.-]*/gi;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    let id = m[0].toLowerCase();
    if (CLAUDE_NOISE.test(id)) continue;
    id = stripTrailingVersionSuffix(id);
    if (id.length < 8) continue;
    seen.add(id);
  }
  return [...seen].sort();
}

function extractOpenAiIds(html: string): string[] {
  const seen = new Set<string>();
  const patterns: RegExp[] = [
    /\bgpt-[a-z0-9][a-z0-9.-]*/gi,
    /\bo[0-9][a-z0-9.-]*/gi,
    /\bwhisper-[a-z0-9-]+/gi,
    /\bdall-e-[0-9]/gi,
    /\btts-[0-9][a-z0-9-]*/gi,
    /\btext-embedding-[a-z0-9-]+/gi,
    /\bchatgpt-[a-z0-9-]+/gi,
    /\bsora-[a-z0-9-]+/gi,
    /\bbabbage-[0-9]+/gi,
    /\bdavinci-[0-9]+/gi,
    /\bcomputer-use-[a-z0-9-]+/gi,
    /\bcodex-mini-[a-z0-9-]+/gi,
    /\bomni-moderation-[a-z0-9-]+/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      let id = m[0].toLowerCase();
      if (id.endsWith('.png')) continue;
      if (OPENAI_DROP.has(id)) continue;
      if (id === 'gpt-oss' || id === 'gpt-image-latest') continue;
      seen.add(id);
    }
  }
  return [...seen].sort();
}

function hyphenlessKey(id: string): string {
  return id.toLowerCase().replace(/_/g, '-').replace(/-/g, '');
}

function buildHyphenlessMaps(
  openai: string[],
  anthropic: string[],
): {
  openaiHyphenless: Record<string, string>;
  anthropicHyphenless: Record<string, string>;
  ambiguousHyphenless: string[];
} {
  const ambiguous: string[] = [];
  const add = (map: Map<string, string>, id: string) => {
    const k = hyphenlessKey(id);
    const prev = map.get(k);
    if (prev !== undefined && prev !== id) {
      if (!ambiguous.includes(k)) ambiguous.push(k);
      map.delete(k);
      return;
    }
    if (!ambiguous.includes(k)) map.set(k, id);
  };
  const o = new Map<string, string>();
  const a = new Map<string, string>();
  for (const id of openai) add(o, id);
  for (const id of anthropic) add(a, id);
  return {
    openaiHyphenless: Object.fromEntries([...o.entries()].sort((x, y) => x[0].localeCompare(y[0]))),
    anthropicHyphenless: Object.fromEntries([...a.entries()].sort((x, y) => x[0].localeCompare(y[0]))),
    ambiguousHyphenless: ambiguous.sort(),
  };
}

async function fetchText(url: string): Promise<{ ok: boolean; status: number; body: string; error?: string }> {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      redirect: 'follow',
    });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, body: '', error: err };
  }
}

async function main(): Promise<void> {
  const fetchedAtIso = new Date().toISOString();
  const sourceResults: Array<{
    name: 'anthropic' | 'openai';
    url: string;
    ok: boolean;
    httpStatus: number;
    error?: string;
    idCount: number;
  }> = [];

  let anthropicIds: string[] = [];
  let openaiIds: string[] = [];

  const a = await fetchText(SOURCES.anthropic.url);
  sourceResults.push({
    name: 'anthropic',
    url: SOURCES.anthropic.url,
    ok: a.ok,
    httpStatus: a.status,
    error: a.error,
    idCount: 0,
  });
  if (a.ok && a.body) {
    anthropicIds = extractAnthropicIds(a.body);
    sourceResults[sourceResults.length - 1].idCount = anthropicIds.length;
  } else if (!a.ok) {
    sourceResults[sourceResults.length - 1].error = a.error ?? `HTTP ${a.status}`;
  }

  const o = await fetchText(SOURCES.openai.url);
  sourceResults.push({
    name: 'openai',
    url: SOURCES.openai.url,
    ok: o.ok,
    httpStatus: o.status,
    error: o.error,
    idCount: 0,
  });
  if (o.ok && o.body) {
    openaiIds = extractOpenAiIds(o.body);
    sourceResults[sourceResults.length - 1].idCount = openaiIds.length;
  } else if (!o.ok) {
    sourceResults[sourceResults.length - 1].error = o.error ?? `HTTP ${o.status}`;
  }

  if (anthropicIds.length === 0 && openaiIds.length === 0) {
    console.error('model-catalog: both sources failed or produced no IDs; refusing to write empty catalog.');
    process.exit(1);
  }

  const { openaiHyphenless, anthropicHyphenless, ambiguousHyphenless } = buildHyphenlessMaps(openaiIds, anthropicIds);

  const catalog = {
    schemaVersion: 1 as const,
    fetchedAtIso,
    recommendedRefreshDays: 7,
    sources: sourceResults,
    providers: {
      anthropic: { apiIds: anthropicIds },
      openai: { apiIds: openaiIds },
    },
    lookup: {
      /** Maps hyphen-removed lowercase keys to canonical API id when unambiguous. */
      openaiHyphenless,
      anthropicHyphenless,
      /** Keys where two+ canonical IDs collapse to the same hyphenless form (do not trust lookup). */
      ambiguousHyphenless,
    },
  };

  mkdirSync(dirname(OUT_PATH), { recursive: true });
  writeFileSync(OUT_PATH, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
  console.log(
    `Wrote ${OUT_PATH} (anthropic: ${anthropicIds.length} ids, openai: ${openaiIds.length} ids, ambiguous hyphenless: ${ambiguousHyphenless.length}).`,
  );
  for (const s of sourceResults) {
    const extra = s.error ? ` — ${s.error}` : '';
    console.log(`  ${s.name}: ${s.ok ? 'ok' : 'FAIL'} (${s.idCount} ids)${extra}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
