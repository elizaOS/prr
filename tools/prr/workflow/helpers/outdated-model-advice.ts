/**
 * Detect review comments that wrongly flag catalog-valid API model IDs (training-cutoff bots).
 *
 * **Scope:** Framing regex + parse (good,bad) pair + require both in committed catalog.
 * **No file I/O** in parsers here; `getOutdatedModelCatalogDismissal` loads the catalog only when
 * returning a dismissal (for staleness hint text).
 *
 * WHY separate from solvability: Keeps `assessSolvability` thin and makes unit tests easy;
 * auto-heal reuses the same dismissal predicate so dismiss and heal stay consistent.
 */

import {
  isModelCatalogStale,
  loadModelProviderCatalog,
  resolveCatalogModelId,
} from '../../../../shared/model-catalog.js';
import { debug } from '../../../../shared/logger.js';

const ENV_DISABLE_SOLVABILITY = 'PRR_DISABLE_MODEL_CATALOG_SOLVABILITY';

/**
 * Framing: the comment asserts an id is **wrong**, invalid, or hallucinated — not a neutral
 * performance/cost preference. WHY: We must not dismiss legitimate "use a smaller model" advice
 * that does not claim the current id is nonexistent.
 */
const INVALID_FRAMING_RE =
  /\b(model\s+name\s+typo|typo\s*[:\s].*model|invalid\s+model|incorrect\s+model\s+name|not\s+a\s+valid\s+model|not\s+valid\s+model|wrong\s+model\s+name|wrong\s+model\b|does\s+not\s+exist|non-?existent\s+model|hallucinated\s+model|fix:\s*change.*model)/i;

function looksLikeModelSlug(id: string): boolean {
  const s = id.trim().toLowerCase();
  if (s.length < 4 || s.length > 80) return false;
  return /^(gpt-|claude-|o[0-9]|chatgpt-|text-embedding-|dall-e-|whisper-)/i.test(s);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface ModelRenamePair {
  /** Catalog-correct id the PR should keep (bot wrongly flagged it). */
  catalogGoodId: string;
  /** Id the bot wrongly suggested (may appear in the file after a bad "fix"). */
  wronglySuggestedId: string;
}

/**
 * Parse (catalogGoodId, wronglySuggestedId) from common bot phrasing.
 * WHY naming: Auto-heal replaces the **suggested** (wrong) literal with the **catalog** id the PR
 * should keep. Returns null if no confident pair (fail-closed for dismissal/heal).
 */
export function parseModelRenameAdvice(body: string): ModelRenamePair | null {
  const t = body.replace(/\r\n/g, '\n');
  // use `B` instead of `A` → keep A, bad B
  let m = t.match(
    /\buse\s+[`"']([a-z0-9][a-z0-9.-]*)[`"']\s+instead\s+of\s+[`"']([a-z0-9][a-z0-9.-]*)[`"']/i,
  );
  if (m) {
    const bad = m[1]!.toLowerCase();
    const good = m[2]!.toLowerCase();
    if (looksLikeModelSlug(good) && looksLikeModelSlug(bad) && good !== bad) return { catalogGoodId: good, wronglySuggestedId: bad };
  }
  m = t.match(/\buse\s+([a-z0-9][a-z0-9.-]*)\s+instead\s+of\s+([a-z0-9][a-z0-9.-]*)\b/i);
  if (m) {
    const bad = m[1]!.toLowerCase();
    const good = m[2]!.toLowerCase();
    if (looksLikeModelSlug(good) && looksLikeModelSlug(bad) && good !== bad) return { catalogGoodId: good, wronglySuggestedId: bad };
  }
  // have `A` instead of `B` or still have `A` instead of `B` → file has A (keep), bot wants B (bad)
  m = t.match(/\b(?:still\s+)?have\s+(?:incorrect\s+model\s+name\s+)?[`"']([a-z0-9][a-z0-9.-]*)[`"']\s+instead\s+of\s+[`"']([a-z0-9][a-z0-9.-]*)[`"']/i);
  if (m) {
    const good = m[1]!.toLowerCase();
    const bad = m[2]!.toLowerCase();
    if (looksLikeModelSlug(good) && looksLikeModelSlug(bad) && good !== bad) return { catalogGoodId: good, wronglySuggestedId: bad };
  }
  m = t.match(/\b(?:still\s+)?have\s+(?:incorrect\s+model\s+name\s+)?([a-z0-9][a-z0-9.-]*)\s+instead\s+of\s+([a-z0-9][a-z0-9.-]*)\b/i);
  if (m) {
    const good = m[1]!.toLowerCase();
    const bad = m[2]!.toLowerCase();
    if (looksLikeModelSlug(good) && looksLikeModelSlug(bad) && good !== bad) return { catalogGoodId: good, wronglySuggestedId: bad };
  }
  // change A to B → keep A, bad B
  m = t.match(
    /\bchange\s+[`"']([a-z0-9][a-z0-9.-]*)[`"']\s+to\s+[`"']([a-z0-9][a-z0-9.-]*)[`"']/i,
  );
  if (m) {
    const good = m[1]!.toLowerCase();
    const bad = m[2]!.toLowerCase();
    if (looksLikeModelSlug(good) && looksLikeModelSlug(bad) && good !== bad) return { catalogGoodId: good, wronglySuggestedId: bad };
  }
  m = t.match(/\bchange\s+([a-z0-9][a-z0-9.-]*)\s+to\s+([a-z0-9][a-z0-9.-]*)\b/i);
  if (m) {
    const good = m[1]!.toLowerCase();
    const bad = m[2]!.toLowerCase();
    if (looksLikeModelSlug(good) && looksLikeModelSlug(bad) && good !== bad) return { catalogGoodId: good, wronglySuggestedId: bad };
  }
  // replace A with B
  m = t.match(
    /\breplace\s+[`"']([a-z0-9][a-z0-9.-]*)[`"']\s+with\s+[`"']([a-z0-9][a-z0-9.-]*)[`"']/i,
  );
  if (m) {
    const good = m[1]!.toLowerCase();
    const bad = m[2]!.toLowerCase();
    if (looksLikeModelSlug(good) && looksLikeModelSlug(bad) && good !== bad) return { catalogGoodId: good, wronglySuggestedId: bad };
  }
  // A → B or A -> B
  m = t.match(/[`"']([a-z0-9][a-z0-9.-]*)[`"']\s*(?:→|->)\s*[`"']([a-z0-9][a-z0-9.-]*)[`"']/i);
  if (m) {
    const good = m[1]!.toLowerCase();
    const bad = m[2]!.toLowerCase();
    if (looksLikeModelSlug(good) && looksLikeModelSlug(bad) && good !== bad) return { catalogGoodId: good, wronglySuggestedId: bad };
  }
  // CodeRabbit/Cursor: heading "### Model name typo `gpt-5-mini`" with separate "use `gpt-4o-mini`" / "recommended `...`"
  // later in the body (pair not on one line). catalogGoodId = id wrongly flagged as typo; wronglySuggestedId = bot's pick.
  if (/\bmodel\s+name\s+typo\b/i.test(t)) {
    const typoPick = t.match(/\bmodel\s+name\s+typo[^`'"\n]{0,160}[`'"]([a-z0-9][a-z0-9.-]*)[`"']/i);
    if (typoPick) {
      const flagged = typoPick[1]!.toLowerCase();
      if (!looksLikeModelSlug(flagged)) return null;
      const fromTypo = t.slice((typoPick.index ?? 0) + typoPick[0].length);
      const suggestRe =
        /\b(?:use|recommend|recommended|prefer|should\s+use|change\s+(?:it|this)\s+to|update\s+to)\s+[`"']([a-z0-9][a-z0-9.-]*)[`"']/gi;
      let suggested: string | null = null;
      let sm: RegExpExecArray | null;
      while ((sm = suggestRe.exec(fromTypo)) !== null) {
        const cand = sm[1]!.toLowerCase();
        if (looksLikeModelSlug(cand) && cand !== flagged) suggested = cand;
      }
      if (suggested) return { catalogGoodId: flagged, wronglySuggestedId: suggested };
    }
  }
  return null;
}

export function commentSuggestsInvalidModelId(body: string): boolean {
  if (!body || body.length < 20) return false;
  return INVALID_FRAMING_RE.test(body);
}

/**
 * True when both strings resolve in the committed provider catalog to **different** canonical ids.
 * WHY require distinct canonicals: If they normalize to the same vendor id, there is no bogus
 * "rename" to dismiss — treat as noise or a wording duplicate.
 */
export function catalogValidatesBothIds(good: string, bad: string): boolean {
  try {
    const a = resolveCatalogModelId(good);
    const b = resolveCatalogModelId(bad);
    return a !== null && b !== null && a.canonicalId !== b.canonicalId;
  } catch {
    return false;
  }
}

export interface OutdatedModelCatalogDismissal {
  reason: string;
  pair: ModelRenamePair;
}

/**
 * If this comment should be dismissed as outdated vendor/model advice, return dismissal payload.
 * Fail-open when catalog missing or env disables — WHY: Missing JSON or fetch errors should not
 * block the rest of PRR; we only skip dismissal, not crash.
 */
export function getOutdatedModelCatalogDismissal(body: string | undefined | null): OutdatedModelCatalogDismissal | null {
  if (process.env[ENV_DISABLE_SOLVABILITY]?.trim() === '1') {
    debug('[Auto-heal detection] Disabled via PRR_DISABLE_MODEL_CATALOG_SOLVABILITY=1');
    return null;
  }
  
  if (!body) {
    debug('[Auto-heal detection] No body text');
    return null;
  }
  
  // Most comments don't mention vendor model IDs — skip silently (per-comment debug was very noisy; Cycle 64 L1).
  if (!commentSuggestsInvalidModelId(body)) {
    return null;
  }
  
  debug('[Auto-heal detection] Comment suggests invalid model ID', { 
    bodySnippet: body.substring(0, 200),
  });
  
  const pair = parseModelRenameAdvice(body);
  if (!pair) {
    debug('[Auto-heal detection] Could not parse model rename advice from body', { 
      bodySnippet: body.substring(0, 300),
    });
    return null;
  }
  
  debug('[Auto-heal detection] Parsed model rename pair', {
    catalogGoodId: pair.catalogGoodId,
    wronglySuggestedId: pair.wronglySuggestedId,
  });
  
  if (!catalogValidatesBothIds(pair.catalogGoodId, pair.wronglySuggestedId)) {
    debug('[Auto-heal detection] Catalog does not validate both IDs as distinct', {
      catalogGoodId: pair.catalogGoodId,
      wronglySuggestedId: pair.wronglySuggestedId,
    });
    return null;
  }
  
  debug('[Auto-heal detection] Catalog validates both IDs - dismissal match', {
    catalogGoodId: pair.catalogGoodId,
    wronglySuggestedId: pair.wronglySuggestedId,
  });
  
  let reason = `Outdated model-id advice: both \`${pair.catalogGoodId}\` and \`${pair.wronglySuggestedId}\` are public API spellings per generated/model-provider-catalog.json — not a fixer task`;
  try {
    const cat = loadModelProviderCatalog();
    if (isModelCatalogStale(cat)) {
      reason += ' (catalog snapshot may be stale; run npm run update-model-catalog)';
      debug('[Auto-heal detection] Catalog is stale');
    }
  } catch (err) {
    debug('[Auto-heal detection] Failed to load/check catalog', { error: err instanceof Error ? err.message : String(err) });
    /* reason unchanged */
  }
  return { reason, pair };
}
