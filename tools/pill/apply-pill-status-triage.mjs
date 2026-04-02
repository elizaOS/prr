#!/usr/bin/env node
/**
 * One-off / repeatable: fill missing **Status:** lines in pill-output.md and remove
 * Historical run banners. Heuristics triaged against tools/prr + shared (2026-04-02).
 */
import fs from 'fs';

const PATH = new URL('../../pill-output.md', import.meta.url).pathname;

function computeStatus(pathRaw, block) {
  const path = pathRaw.toLowerCase();
  const desc = block.toLowerCase();
  const combined = `${path}\n${desc}`;

  const done = (s) => `**Status:** Done (prr) — ${s}`;
  const partial = (s) => `**Status:** Partial (prr) — ${s}`;
  const openPr = (s) => `**Status:** Open (prr) — ${s}`;
  const openOps = (s) => `**Status:** Open (ops) — ${s}`;
  const superPr = (s) => `**Status:** Superseded (prr) — ${s}`;
  const obsolete = (s) => `**Status:** Obsolete / N/A — ${s}`;
  const ext = (s) => `**Status:** N/A (external) — ${s}`;

  if (path.includes('tools/prr/src/')) {
    return obsolete('Pill path not in this repo; PRR sources are `tools/prr/` + `shared/`.');
  }
  if (path.includes('shared/src/')) {
    return obsolete('No `shared/src/` tree in the prr monorepo.');
  }
  if (/^src\//.test(path) || path.startsWith('packages/')) {
    return ext('PR clone / product layout, not prr tool sources.');
  }
  if (path === 'docs/agents.md' || path.endsWith('/docs/agents.md')) {
    return obsolete('Use root `AGENTS.md`.');
  }
  if (
    path.includes('path-resolver.ts') ||
    path.includes('resolve-path.ts') ||
    path.includes('path-resolution.ts') ||
    path.includes('file-resolver.ts') ||
    path.includes('path-accounting.ts')
  ) {
    return obsolete('No such helper filename in this tree; path logic in `shared/path-utils.ts`, `solvability.ts`, `issue-analysis.ts`.');
  }
  if (path.includes('helpers/state.ts')) {
    return obsolete('State mutations live in `tools/prr/state/` (`state-verification`, `state-dismissed`, `state-core`), not `workflow/helpers/state.ts`.');
  }
  if (path === 'shared/state.ts' || path.endsWith('/shared/state.ts')) {
    return obsolete('PRR state lives under `tools/prr/state/`, not `shared/state.ts`.');
  }

  if (path.includes('pr-state.ts')) {
    return obsolete('No `pr-state.ts` module; persistence + overlap cleanup in `state-core.ts`, `manager.ts`, `state-verification.ts`.');
  }

  if (
    path.includes('tools/prr/state') ||
    path.includes('state/manager.ts') ||
    path === 'tools/prr/state.ts' ||
    path.includes('tools/prr/state/')
  ) {
    if (/headsha|head sha|rebase|dismissed array|clear.*dismissed|stale dismiss/i.test(block)) {
      return partial(
        '`state-core.ts` / `manager.ts`: verified + overlap cleanup on load; `already-fixed` dismissals cleared on HEAD change; full `dismissedIssues` clear only with `PRR_CLEAR_ALL_DISMISSED_ON_HEAD=1`.',
      );
    }
    return done('`markVerified` / `dismissIssue` + `load` overlap cleanup (`state-core`, `manager`, `state-verification`).');
  }

  if (path.includes('shared/path-utils.ts')) {
    if (/\.json.*\.js|reverse|asymmetric|extension_variant_map.*\.json/i.test(block) && !/fragment|\.d\.ts/i.test(block)) {
      return partial('`EXTENSION_VARIANT_MAP` covers `.js`→`.json` etc.; reverse `.json`→`.js` not fully symmetric — extend map if needed.');
    }
    if (/unit test|tests for tryresolve/i.test(block)) {
      return openPr('Add/expand tests under `tests/` for `tryResolvePathWithExtensionVariants` + fragments if coverage gaps remain.');
    }
    return done('`tryResolvePathWithExtensionVariants`, `pathDismissCategoryForNotFound`, `isReviewPathFragment` (+ `.d.ts` handling).');
  }

  if (path.includes('solvability.ts')) {
    return done('Wired to `path-utils` + canonical dismissal categories.');
  }

  if (path.includes('dismissal.ts')) {
    return done('Categories canonicalized via `path-utils` + state load normalization.');
  }

  if (path.includes('shared/llm/elizacloud.ts')) {
    if (/stream|debugresponse|chunk/i.test(block)) {
      return superPr('`elizacloud.ts` is client factory; empty-body handling + logging in `tools/prr/llm/client.ts` `complete()`.');
    }
    return done('Skip list applied via `getEffectiveElizacloudSkipModelIds()` (`shared/constants/models.ts`) + `rotation.ts`, not dispatch-only in this file.');
  }

  if (path.includes('shared/constants.ts') || path.includes('constants/models')) {
    if (/skip.*model|0%/i.test(block)) {
      return openOps('Refresh `ELIZACLOUD_SKIP_MODEL_IDS` / reasons from Model Performance when audits warrant.');
    }
  }

  if (path.includes('rotation.ts') && /session|0%|consecutive|failure count/i.test(block)) {
    return done('`PRR_SESSION_MODEL_SKIP_FAILURES` + `recordSessionModelVerificationOutcome` in rotation.');
  }

  if (path.includes('rate-limit.ts')) {
    return done('Restores full `PRR_MAX_CONCURRENT_LLM` after 429 window (`wasIn429Backoff`).');
  }

  if (path.includes('run-with-concurrency.ts')) {
    if (/promise\.all|batch|reject|429|halving|non-429/i.test(block)) {
      return partial('`runWithConcurrencyAllSettled` for partial batch results; pill chunked audit still uses `runWithConcurrency` — consider AllSettled + per-chunk errors there.');
    }
    return done('Pool + optional `PRR_LLM_TASK_TIMEOUT_MS` per task.');
  }

  if (path.includes('tools/prr/llm/client.ts')) {
    return done('`debugPromptError` / empty success body handling on `complete()`.');
  }

  if (path.includes('shared/logger.ts')) {
    if (/counter|map.*slug|structured/i.test(block)) {
      return openPr('`PROMPTLOG_EMPTY_BODY` marker exists; optional aggregated counters not implemented.');
    }
    return done('`PROMPTLOG_EMPTY_BODY` in `writeToPromptLog` for zero-length bodies.');
  }

  if (path.includes('outdated-model-advice.ts')) {
    if (/empty catalog|0a6|catalog unavailable/i.test(block)) {
      return partial('Loader warns on empty catalog; confirm 0a6 never dismisses as not-an-issue when catalog empty.');
    }
    return partial('0a6 catalog-dismiss + related solvability; auto-heal in `catalog-model-autoheal.ts`.');
  }

  if (path.includes('catalog-model-autoheal.ts')) {
    return partial('±20 anchor + full-file fallback; tighten multi-match guards if audits show over-replacement.');
  }

  if (path.includes('recovery.ts') && /overlap|verified.*dismissed/i.test(block)) {
    return done('Mutual exclusivity enforced in `markVerified` / `dismissIssue`; load repairs legacy overlap.');
  }

  if (path.includes('workflow/analysis.ts') && /overlap|mutual/i.test(block)) {
    return done('Overlap warning in `runFinalAudit` (console + debug).');
  }


  if (path.includes('no-changes-verification.ts')) {
    return done('Paths calling `markVerified` strip dismissed as in state layer.');
  }

  if (path.includes('git-commit-scan.ts')) {
    if (/case|insensitive|graphql/i.test(block)) {
      return openPr('Verify recovered-id comparison is case-insensitive end-to-end; extend if any path still uses strict equality.');
    }
    return partial('`recoverVerificationState` / `scanCommittedFixes`; confirm recovery respects verified∩dismissed + `markVerified` (extend if recovery can reintroduce overlap).');
  }

  if (path.includes('git-clone-core.ts') && /rev-parse|verify|ref/i.test(block)) {
    return done('`verifyAdditionalRemoteRefs` + `git.raw([\'rev-parse\', \'--verify\', ...])` for additional branches.');
  }

  if (path.includes('git-lock-files.ts') && /index\.lock|unlink|retry/i.test(block)) {
    return openPr('No `.git/index.lock` cleanup in this module (file is dependency-lock helpers); add elsewhere if still needed.');
  }

  if (path.includes('run-setup-phase.ts') && /unmergeable|exit.*clone/i.test(block)) {
    return done('`PRR_EXIT_ON_UNMERGEABLE` exit before clone when documented.');
  }

  if (path.includes('tools/pill/')) {
    if (/chunk|504|per-chunk|promise\.all/i.test(block)) {
      return openPr('Chunked audit uses `runWithConcurrency`; one failed chunk can fail the whole audit — isolate per chunk (e.g. AllSettled + merge).');
    }
    return partial('See `tools/pill/`; triage any remaining items against current orchestrator.');
  }

  if (path.includes('agents.md') && !path.includes('docs/')) {
    return partial('Root `AGENTS.md` covers invariants, skip list, paths, pill triage; optional deeper runbook still open.');
  }

  if (path.includes('development.md')) {
    return partial('DEVELOPMENT.md updated over time; align any stale `src/` references with `tools/prr/` + `shared/` as needed.');
  }

  if (path.includes('readme.md')) {
    return partial('README + operator tables evolve; spot-check against current env flags.');
  }

  if (path.includes('models.md')) {
    return done('Skip list + overrides documented in `docs/MODELS.md` + `shared/constants/models.ts` comments.');
  }

  if (path.includes('shared/config.ts')) {
    if (/skip|elizacloud_skip|parse.*nan|session_model|isvalidmodel/i.test(block)) {
      return partial('Skip list IDs merged in `shared/constants/models.ts`; env parsing / model validation in `shared/config.ts` — extend guards if audits show gaps.');
    }
    return partial('`loadConfig()` + env surface; cross-check new flags with README / `.env.example`.');
  }

  if (path.includes('shared/model-catalog.ts')) {
    return openPr('Optional `isKnownModel` / stricter parse helpers; catalog load fails soft today.');
  }

  if (path.includes('tools/prr/readme.md')) {
    return openPr('Expand runner install checklist + `--check-tools` if not fully documented.');
  }

  if (path.includes('tests/readme.md')) {
    return openPr('Optional testing guide for invariants; tests live under `tests/`.');
  }

  if (path.includes('verifier.md') || path.includes('prompts/')) {
    return openPr('Prompt tweaks in `tools/prr/prompts/` — verify line-citation rules vs verifier behavior.');
  }

  if (/dedup|issue-analysis|group.*canonical/i.test(combined) && path.includes('workflow')) {
    return partial('Dedup validation / heuristics in `issue-analysis` + related; tighten single-member GROUP handling if needed.');
  }

  if (path.includes('story-read') || path.includes('story_read')) {
    return partial('`chunkPlainText` + caps; oversized single-line chapters — confirm truncation vs token budget in `shared/llm/story-read`.');
  }

  if (path.includes('workflow/helpers/recovery.ts') && /lesson|diff.*lesson/i.test(block)) {
    return openPr('Guard fixer diffs that only touch `.prr/lessons.md` vs target file if not already enforced.');
  }

  if (path.includes('runners/detect.ts') || path.includes('fixer')) {
    if (/zero.*tool|early.exit|non-zero/i.test(block)) {
      return openPr('Loud warn when no fixer CLIs detected; fail-fast optional.');
    }
    return done('Debug logging when runners skipped (`shared/runners/detect.ts`).');
  }

  if (path.includes('coderabbit') || path.includes('code-rabbit')) {
    return openPr('Stale bot SHA warn + optional `PRR_EXIT_ON_STALE_BOT_REVIEW`; wait/poll after trigger is product-specific.');
  }

  if (path.includes('docs/') || path.includes('architecture')) {
    return partial('See root `AGENTS.md` + `DEVELOPMENT.md`; avoid duplicate `docs/AGENTS.md` in this repo.');
  }

  if (path.includes('git-push.ts')) {
    return done('`pushWithRetry` + conflict path warnings in shared git push helpers.');
  }

  if (path.includes('git-helpers.ts')) {
    return partial('Shared git utilities; triage specific item against `shared/git/` exports.');
  }

  if (path.includes('shared/git/') && /lock|race|index/i.test(block)) {
    return openPr('`git-lock-files.ts` covers dependency locks, not `.git/index.lock`; pill item may describe foreign tooling.');
  }

  if (path.includes('tools/prr/github/') || path.includes('thread')) {
    return partial('Thread replies + idempotency documented in `docs/THREAD-REPLIES.md` + `AGENTS.md`.');
  }

  if (path.includes('ui/') || path.includes('reporter.ts')) {
    return done('Overlap surfaced in RESULTS SUMMARY / reporter (`overlapVerifiedAndDismissed`).');
  }

  if (path.includes('schema.ts') && /zod|overlap/i.test(block)) {
    return partial('Overlap repaired on load; strict Zod fail on overlap not default.');
  }

  if (path.includes('package.json') || path.includes('workflow.yml') || path.includes('.github')) {
    return ext('CI / packaging for product or foreign layout unless path is under this tool repo.');
  }

  if (path === 'tools/prr/' || path.endsWith('/tools/prr/')) {
    if (/path|resolv|dismiss|solvab|normaliz/i.test(block)) {
      return done('Uses `shared/path-utils.ts` + `solvability.ts` + workflow resolution; see canonical path rules in `AGENTS.md`.');
    }
    return partial('Orchestration across `resolver.ts` + `workflow/`; compare themes to **2026-03-23** items.');
  }

  if (path.includes('tools/prr/resolver.ts')) {
    return partial('Main PRR entry orchestration; state/path/skip fixes live in `state/`, `path-utils`, `models/rotation.ts`.');
  }

  if (path.includes('tools/prr/workflow/') && !/\/helpers\//.test(path)) {
    if (/path|resolv|dismiss/i.test(block)) {
      return done('Workflow uses shared path + solvability pipeline (see `AGENTS.md`).');
    }
    return partial('See `tools/prr/workflow/` modules; map item to helper file for detail.');
  }

  if (path.includes('workflow/analysis.ts')) {
    return partial('`runFinalAudit`, overlap warning, issue analysis / dedup — see `analysis.ts` + `issue-analysis.ts`.');
  }

  if (path.includes('shared/llm/') && !path.includes('elizacloud.ts')) {
    return partial('Shared LLM helpers; PRR primary transport + `complete()` in `tools/prr/llm/client.ts`.');
  }

  if (path.includes('.cursor/rules')) {
    return done('Project rules under `.cursor/rules/` + `AGENTS.md`; update when audits add invariants.');
  }

  if (path.includes('audit-cycles.md')) {
    return partial('Regression / audit narrative in `tools/prr/AUDIT-CYCLES.md` (template per `.cursor/rules`).');
  }

  if (path.includes('state-mutual-exclusivity') || path.includes('state-overlap.test')) {
    return openPr('Add focused tests under `tests/` if missing; overlap cleanup in `state-core` / `markVerified` / `dismissIssue`.');
  }

  if (path.includes('shared/version') || path.includes('version-info.ts')) {
    return obsolete('No `shared/version*.ts` in this repo; version from `package.json` / release tooling.');
  }

  if (path === '.env.example' || path.endsWith('/.env.example')) {
    return done('Root `.env.example` documents PRR_* toggles + pointers to `shared/constants` / `docs/MODELS.md`.');
  }

  return partial(`Unclassified path — review against **2026-03-23 02:25** / **2026-03-26 02:47** items: \`${pathRaw}\`.`);
}

function main() {
  let text = fs.readFileSync(PATH, 'utf8');
  text = text.replace(/\n\*\*Historical run \(2026-04-02\):\*\*[^\n]*\n/g, '\n');

  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (!/^#### \d+\./.test(line)) {
      out.push(line);
      i++;
      continue;
    }
    const start = i;
    i++;
    while (i < lines.length && !/^#### \d+\./.test(lines[i]) && !/^## /.test(lines[i])) {
      i++;
    }
    const blockLines = lines.slice(start, i);
    const blockLinesFiltered = blockLines.filter(
      (l) =>
        !/^\*\*Status:\*\* Partial \(prr\) — (Triage manually:|Unclassified path)/.test(l),
    );
    const blockText = blockLinesFiltered.join('\n');
    if (blockText.includes('**Status:**')) {
      out.push(...blockLinesFiltered);
      continue;
    }
    const pathMatch = blockLinesFiltered[0]?.match(/^#### \d+\. `([^`]+)`/);
    const pathRaw = pathMatch ? pathMatch[1] : '';
    const statusLine = computeStatus(pathRaw, blockText);
    out.push(...blockLinesFiltered);
    out.push(statusLine);
  }

  const result = out.join('\n');
  fs.writeFileSync(PATH, result, 'utf8');
  console.error('Updated', PATH);
}

main();
