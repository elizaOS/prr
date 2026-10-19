# INV-011: Strict final audit — orchestration / early exit

## Why This Document

**`PRR_STRICT_FINAL_AUDIT`** is useless if **`post-verification-handling`** never runs when the main loop exits early (“all verified”). **`PRR_STRICT_FINAL_AUDIT_UNCERTAIN`** must gate uncertain verdicts, not only **`PRR_STRICT_FINAL_AUDIT`**. Separate from verifier snippets (**`INV-004`**) and state overlap (**`INV-010`**).

## State

- **Status:** Open
- **Priority:** High
- **Area:** workflow / exit paths
- **Hits:** 24
- **Events:** 2026-04-08, 2026-04-09, 2026-04-10, 2026-04-11, 2026-04-12, 2026-04-13, 2026-04-14, 2026-04-25, 2026-04-26

## Evidence

- **`## 2026-04-08 23:56`**: **25** **`final-audit-uncertain.ts`** — structured per-issue **UNCERTAIN**/truncation telemetry (not only **RESULTS** line). **Raw § removed after triage.**
- **`## 2026-04-09 00:27`**: **23** **`final-audit-uncertain.ts`** + **`client.ts`** — structured demotion log + **RESULTS** counter; **`PRR_STRICT_FINAL_AUDIT_UNCERTAIN`** surfaces risk. **Raw § removed after triage.**
- **`## 2026-04-09 01:00`**: **5** **`run-orchestrator.ts`** — non-zero exit when **RESULTS** overlap remains (CI) (**pairs** **INV-010** auto-repair); **25** **`final-audit-uncertain.ts`** — demote only with positive truncation metadata, not inferred from short snippet. **Raw § removed after triage.**
- **`## 2026-04-09 01:17`**: **6** **`run-orchestrator.ts`** — non-zero exit when **RESULTS** **`verified∩dismissed`** non-empty; **7** log when **`PRR_STRICT_FINAL_AUDIT`** unset; **26** **`client.ts`** — structured warn + **RESULTS** counter for **UNFIXED→UNCERTAIN** demotion; **27** **`final-audit-uncertain.ts`** — unit tests (truncation vs line evidence). **Raw § removed after triage.**
- **`## 2026-04-09 21:22`**: **11** **`final-audit-uncertain.ts`** / **`client.ts`** — truncation-guard must not demote when model cites line-level evidence. **Raw § removed after triage.**
- **`## 2026-04-10 04:40`**: **22** **`final-audit-uncertain.ts`** — parrot / high token-overlap vs review text → low confidence (**pairs** **`client.ts`** truncation guard). **Raw § removed after triage.**
- **`## 2026-04-10 07:17`**: **21** **`tools/prr/llm/client.ts`** + **`final-audit-uncertain.ts`** / **RESULTS** — operator-visible **UNCERTAIN** vs truncation-guard vs **FIXED** breakdown (**pairs** **INV-004** demotion log). **22** **`final-audit-uncertain.ts`** — end-of-run summary counts for strict exit. **Raw § removed after triage.**
- **`## 2026-04-10 10:05`**: **21** **`tools/prr/workflow/helpers/final-audit-uncertain.ts`** — **UNCERTAIN** / truncation-guard counts in **RESULTS** + strict exit message body (**`PRR_STRICT_FINAL_AUDIT_UNCERTAIN`**). **Raw § removed after triage.**
- **`## 2026-04-11 18:47`**: **6** **`AGENTS.md`** vs **`shared/config.ts`** — **`PRR_STRICT_FINAL_AUDIT_UNCERTAIN`** discoverability (env honored in **`tools/prr/index.ts`**, not necessarily exported from **`loadConfig()`**); clone workdir vs **`.pr-resolver-state.json`**. **19** **`final-audit-uncertain.ts`** — tighten **UNCERTAIN** when snippet truncated; operator-visible warn when **UNCERTAIN** passes. **Raw § removed after triage.**
- **`pill-output.md`** — **`## 2026-04-26 17:49`**, item **4**: **`tools/prr/workflow/post-verification-handling.ts`** — ensure strict final audit runs even when **`push-iteration-loop`** / orchestrator short-circuits because all comments look resolved. Real paths: **`tools/prr/workflow/post-verification-handling.ts`**, **`tools/prr/workflow/run-orchestrator.ts`**, **`tools/prr/workflow/push-iteration-loop.ts`**.
- **`## 2026-04-26 17:19`**, item **3**: **`PRR_STRICT_FINAL_AUDIT_UNCERTAIN`** — **`post-verification-handling.ts`** should treat low-confidence / **UNCERTAIN** verification as open when strict flag is set (pairs with **`INV-004`** truncation guard). **Raw § removed after triage.**
- **`## 2026-04-26 16:57`**, item **13**: **`final-audit-uncertain.ts`** — surface **UNCERTAIN** / truncation-guard soft-passes in **RESULTS SUMMARY** (operator visibility; **`PRR_STRICT_FINAL_AUDIT_UNCERTAIN`**). **Raw § removed after triage.**
- **`## 2026-04-26 07:12`**, item **21**: ordering — truncation-guard demotion in **`client.ts`** before **`analysis.ts`** re-queue decision. **Raw § removed after triage.**
- **`## 2026-04-26 05:57`**: **52** default **`PRR_STRICT_FINAL_AUDIT_UNCERTAIN`** / lenient **UNCERTAIN** passes; **56** **`README.md`** document flag (clone **`fix-and-verify.js`** → **`post-verification-handling.ts`** / **`analysis.ts`**). **54** re-queue vs verified — see **INV-010**. **Raw § removed after triage.**
- **`## 2026-04-26 05:35`**: **5** **`post-verification-handling.ts`** — wire **`PRR_STRICT_FINAL_AUDIT`** / **`PRR_STRICT_FINAL_AUDIT_UNCERTAIN`** (pill claims grep shows gap — **verify** against current **`run-orchestrator.ts`** / helpers before treating as bug). **Raw § removed after triage.**
- **`## 2026-04-25 22:12`**: **7** **`no-changes-verification.ts`** — **`PRR_STRICT_FINAL_AUDIT_UNCERTAIN`** should re-queue **UNCERTAIN** (pill **`verification-loop.ts`** → **`tools/prr/workflow/helpers/no-changes-verification.ts`**); **23** persist **UNCERTAIN** vs confident verified for strict exit on restart (**`final-audit-uncertain.ts`** / state). **Raw § removed after triage.**
- **`## 2026-04-25 09:07`**, **`09:42`**, **`09:57`** (3 sections): **`post-verification-handling.ts`** / **`analysis.ts`** — **`PRR_STRICT_FINAL_AUDIT`**, strict uncertain, early-exit vs final audit; pill **`verification-loop.ts`** → **`workflow/`**. **Raw § removed after triage.**
- **`## 2026-04-14 07:20`**: **4** **RESULTS** overlap → non-zero exit / CI gate; **5** **`shared/config.ts`** — **`envBool`** for **`PRR_STRICT_*`** (**`=== '1'`** vs **`true`**); **22** **`final-audit-uncertain`** logging when **UNCERTAIN** passes. **Raw § removed after triage.**
- **`## 2026-04-14 00:20`**: **6** **`post-verification-handling`** **RESULTS** ∩ dismissed explicit subtract + warn; **23** **`final-audit-uncertain`** — distinguish **UNCERTAIN** vs truncation-guard for **`PRR_STRICT_FINAL_AUDIT_UNCERTAIN`** (**Partial** pill **Status**). **Raw § removed after triage.**
- **`## 2026-04-13 03:31`**: **4** (summary) **`PRR_STRICT_FINAL_AUDIT`** / **`PRR_STRICT_FINAL_AUDIT_UNCERTAIN`** default enforcement narrative; **22** **`final-audit-uncertain.ts`** pill row mixes path-dismissal text with uncertain/truncation-guard (**Partial** **Status** — code is **`client.ts`** / snippet helpers). **Raw § removed after triage.**
- **`## 2026-04-12 18:21`**: **21** stricter **UNCERTAIN** when excerpt not actually truncated; **23** excerpt boundary metadata from **`getFullFileForAudit`** → truncation guard (**Open** / **Partial** pill **Status**). **Raw § removed after triage.**
- **`## 2026-04-12 08:39`**: **21** truncation guard requires **both** truncated snippet **and** missing line-level evidence; **22** log **UNCERTAIN** pass reason (model vs truncation-guard) for **`PRR_STRICT_FINAL_AUDIT_UNCERTAIN`** ops (**Open**). **Raw § removed after triage.**

## Next action

Trace early-exit branches from **`output.log`** / **`run-orchestrator.ts`**; gate success on final audit when **`PRR_STRICT_FINAL_AUDIT`** is set; confirm **`PRR_STRICT_FINAL_AUDIT_UNCERTAIN`** wiring vs **`final-audit-uncertain.ts`** / exit code **2** path; add regression tests.

## Resolution

_(empty until closed.)_
