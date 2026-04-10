import { describe, it, expect, beforeEach } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  loadModelProviderCatalog,
  resetModelProviderCatalogCache,
  resolveCatalogModelId,
  isKnownOpenAiModelId,
  isModelCatalogStale,
} from '../shared/model-catalog.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = join(__dirname, '../generated/model-provider-catalog.json');

describe('model catalog', () => {
  beforeEach(() => resetModelProviderCatalogCache());

  it('loads generated JSON', () => {
    const c = loadModelProviderCatalog(CATALOG_PATH);
    expect(c.schemaVersion).toBe(1);
    expect(c.providers.openai.apiIds.length).toBeGreaterThan(10);
    expect(c.providers.anthropic.apiIds.length).toBeGreaterThan(5);
  });

  it('resolves hyphen-relaxed OpenAI ids', () => {
    const r = resolveCatalogModelId('gpt5-mini');
    expect(r?.provider).toBe('openai');
    expect(r?.canonicalId).toBe('gpt-5-mini');
    expect(r?.match).toBe('hyphenless');
  });

  it('isKnownOpenAiModelId is false for Anthropic-only ids', () => {
    expect(isKnownOpenAiModelId('claude-sonnet-4-6')).toBe(false);
    expect(isKnownOpenAiModelId('gpt-5.4-mini')).toBe(true);
  });

  it('staleness uses recommendedRefreshDays', () => {
    const c = loadModelProviderCatalog(CATALOG_PATH);
    expect(isModelCatalogStale(c, 365 * 100)).toBe(false);
    expect(isModelCatalogStale(c, 0)).toBe(true);
  });

  it('missing catalog path returns empty providers without throwing', () => {
    const missing = join(__dirname, 'this-catalog-file-does-not-exist.json');
    const c = loadModelProviderCatalog(missing);
    expect(c.schemaVersion).toBe(1);
    expect(c.providers.openai.apiIds).toEqual([]);
    expect(c.providers.anthropic.apiIds).toEqual([]);
  });
});
