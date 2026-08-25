# INV-009: `verifiedThisSession` vs PR HEAD change

## Why This Document

Pill flagged **`main-loop-setup.ts`** / commit-gate behavior when **`headSha`** changes; **`verifiedThisSession`** is in-memory and easy to drift from persisted verified clears — track separately from model rotation (**`INV-006`**).

## State

- **Status:** Open
- **Priority:** Medium
- **Area:** state / commit gate
- **Hits:** 13
- **Events:** 2026-04-08, 2026-04-09, 2026-04-12, 2026-04-14, 2026-04-25, 2026-04-29

## Evidence

- **`## 2026-04-08 23:56`**: **9** **`manager.ts`** — on **HEAD** change re-validate / clear **dismissed** where paths may exist post-rebase; **32** **`DEVELOPMENT.md`** — **`PRR_CLEAR_ALL_DISMISSED_ON_HEAD`** semantics + blast radius (**pairs** **INV-010**). **Raw § removed after triage.**
- **`## 2026-04-09 00:27`**: **37** pill **`src/state.ts`** — **HEAD** change leaves non-**`already-fixed`** dismissals stale — re-validate or **`PRR_CLEAR_ALL_DISMISSED_ON_HEAD`** (**`tools/prr/state/manager.ts`**). **Raw § removed after triage.**
- **`## 2026-04-09 01:00`**: **37** pill **`src/state.ts`** — on **HEAD** change re-validate or clear **all** dismissals (not only **`already-fixed`**) — **`tools/prr/state/manager.ts`** / **`PRR_CLEAR_ALL_DISMISSED_ON_HEAD`**. **Raw § removed after triage.**
- **`## 2026-04-09 01:17`**: **40** pill **`tools/prr/src/state.ts`** — file-level diff vs blanket verified clear on **HEAD** change (**`tools/prr/state/manager.ts`** + **`git diff`** scope — pairs **INV-010**). **Raw § removed after triage.**
- **`pill-output.md`** — **`## 2026-04-29 02:06`**, item **2**: clear **`verifiedThisSession`** when **`headSha`** changes alongside **`StateManager.load`** / **`loadState`** verified-array clears (**`tools/prr/state/manager.ts`**, **`state-core.ts`**). **WHY:** Commit gate and catalog auto-heal use **`stateContext.verifiedThisSession`** (**`push-iteration-loop.ts`**, **`catalog-model-autoheal.ts`**); stale IDs could linger if only JSON verified fields are cleared.
- **`## 2026-04-26 05:35`**, item **9**: **`manager.ts`** — on **HEAD** change clear **`dismissedComments`** / dismissed **`commentStatuses`**, not only verified arrays (pairs **INV-010**). **Raw § removed after triage.**
- **`## 2026-04-25 22:12`**, item **34**: HEAD-change asymmetry (**0** verified cleared vs **6** **`already-fixed`** dismissals) — **`commentStatuses`** / ghost state (pill **`src/state.ts`** → **`tools/prr/state/`**). **Raw § removed after triage.**
- **`## 2026-04-25 09:07`**, **`09:42`**, **`09:57`** (3 sections): **`verifiedThisSession`** vs **`dismissed`** in **RESULTS** / overlap counts; **HEAD** change vs surviving dismissals; **`scanCacheKey`** / **`prBaseBranch`** cache collisions (**`git-commit-scan`** — pairs **INV-010**). **Raw § removed after triage.**
- **`## 2026-04-14 03:06`**, item **9**: **`run-orchestrator.ts`** — clear session verified / counters on **HEAD** drift mid-run (**Open** pill **Status** — confirm vs **`manager.ts`** / **`push-iteration-loop.ts`**). **Raw § removed after triage.**
- **`## 2026-04-14 00:20`**, item **2**: **`StateManager.load`** on **`headSha`** change — clear verified **and** dismissed scope / test gap vs pill “clear both arrays” wording (**Partial** — pairs **INV-010**). **Raw § removed after triage.**
- **`## 2026-04-12 18:21`**, item **6**: **`Manager.load`** — pill asks to clear **all** arrays on **HEAD** change vs current partial clear + **`commentStatuses`** nuance (**Partial** — pairs **INV-010**). **Raw § removed after triage.**
- **Raw dated section removed from `pill-output.md` after triage.**

## Next action

Trace **`stateContext.verifiedThisSession`** from **`fix-loop-initialization.ts`** through **`StateManager.load` / `loadState`** on HEAD change; if the Set is not cleared or replaced when persisted verified is cleared, add **`clear()`** (or rebind **`new Set()`**) in the same branch. Add a regression test if missing.

## Resolution

_(empty until closed.)_
