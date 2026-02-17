# Comment Status System

## Problem

Every push iteration, prr asks the LLM "does this issue still exist?" for every unresolved PR comment. For a PR with 25 open comments, that's 25 LLM calls per iteration — even when neither the comment body nor the target file changed since the last check. The LLM gives the exact same answer, burning tokens and adding 5-15 seconds of latency.

PR comments are near-immutable. Once a reviewer posts "nonce consumption is not atomic," that text never changes. The only variable is whether the **code** still exhibits the issue. If the fixer didn't touch the file, the answer is the same as last time.

## Solution

Each PR comment gets an explicit lifecycle status persisted in the state file:

```
(new comment) ──analyze──► open ──fix+verify──► resolved
                               ──dismiss──────► resolved
               ──analyze──► resolved (already fixed / stale)
               open ──file modified──► (status cleared, re-analyze)
```

The status includes the LLM's classification, explanation, triage scores, and a SHA-1 hash of the file content at the time of analysis. On subsequent iterations, comments whose status is "open" and whose file hash still matches are served from the cache — no LLM call needed.

## Architecture

### Three Overlapping Systems

```
System              | Set by                    | Checked by
--------------------|---------------------------|-----------------------------
verifiedFixed[]     | markVerified (15 callers)  | isVerified (15 callers)
dismissedIssues[]   | dismissIssue (9 callers)   | assessSolvability, reporting
commentStatuses{}   | findUnresolvedIssues +     | findUnresolvedIssues
                    | sync hooks                 |
```

**Why three systems instead of one?** `verifiedFixed` and `dismissedIssues` existed first, with 15+ and 9+ call sites respectively. Replacing them with `commentStatuses` would require modifying ~24 call sites and their callers — a risky refactor for a running system. Instead, `commentStatuses` is an optimization layer that caches the LLM's classification. The other two remain authoritative for "is this done?"

### Sync Hooks (The Invariant)

At any point in time, for any comment ID:

```
isVerified(id) = true   →  commentStatuses[id] is resolved OR absent
isDismissed(id) = true  →  commentStatuses[id] is resolved OR absent
commentStatuses[id] = open  →  isVerified(id) = false AND isDismissed(id) = false
```

Without sync hooks, `markVerified()` would update `verifiedFixed` but leave `commentStatuses` showing "open" — a contradiction. The hooks maintain consistency:

| Function | Hook action | Why |
|---|---|---|
| `markVerified()` | Flip status to resolved/fixed | Verified comment should not be re-analyzed |
| `unmarkVerified()` | Delete status entry | Un-verified comment needs fresh analysis |
| `clearAllVerifications()` | Clear all statuses | Bulk reset (e.g., after pulling new commits) |
| `dismissIssue()` | Flip status to resolved/stale | Dismissed comment should not be re-analyzed |
| `undismissIssue()` | Delete status entry | Un-dismissed comment needs fresh analysis |

**Why direct state mutation instead of importing `state-comment-status.ts`?** Avoids circular dependency risk. Both `state-verification.ts` and `state-dismissed.ts` already have `state` in scope from `getState(ctx)`. The hooks use `state.commentStatuses[id]` directly — no new imports needed.

**Why only mutate if entry exists?** `markVerified()` is called for comments that may never have been LLM-analyzed (e.g., recovered from git history, or auto-verified duplicates). Creating a `commentStatuses` entry with fabricated data would pollute the state. Missing entry = never analyzed = nothing to sync.

### Analysis Pipeline (issue-analysis.ts)

```
comments[] (all PR comments)
    │
    ├─ isVerified() gate ──► skip (already fixed)
    │  └─ UNLESS: --reverify OR stale (verified 5+ iterations ago)
    │
    ├─ Solvability check ──► dismiss (deleted file, stale ref)
    │
    ├─ Heuristic dedup ──► group (same file + line)
    │
    ├─ LLM semantic dedup ──► group (different lines, same issue)
    │
    ├─ Comment status cache ──► skip open+unchanged files
    │  └─ UNLESS: --reverify OR stale verification (forceReanalyze)
    │
    └─ LLM analysis ──► classify as open/resolved
```

### File Content Hashing

Each "open" status records a SHA-1 prefix of the file content at analysis time. On the next iteration:

- **File unchanged** (hash matches): Status is valid — skip LLM.
- **File changed** (hash mismatch): Status is stale — send to LLM for fresh analysis.
- **File deleted**: Hash is `__missing__` — triggers fresh analysis which then dismisses as stale.

**Why SHA-1 prefix, not full hash?** The first 16 hex chars (64 bits) are sufficient for collision avoidance within a single PR's file set. Full SHA-1 would work but wastes storage in the state file for no practical benefit.

### Hash Relaxation for Resolved Entries

The sync hooks use spread (`...state.commentStatuses[id]`) to preserve the original hash when flipping status to "resolved." This means resolved entries may have stale hashes. The fix:

`getValidStatus()` only validates hashes for "open" entries. Resolved entries pass through without hash validation because:

1. Resolved entries are caught by `isVerified()`/`isDismissed()` gates **before** reaching `getValidStatus()`.
2. If a resolved entry somehow reaches this check (gate bug), the resolved path re-dismisses it — idempotent and harmless.

### The Stale Verification Trap

This is the subtlest interaction in the system. Three features conspire:

1. **Stale verification**: Comments verified 5+ iterations ago are re-checked (the `isVerified()` gate is bypassed).
2. **Sync hooks**: `markVerified()` flips `commentStatuses` to "resolved."
3. **Hash relaxation**: Resolved entries pass hash validation.

Without a guard, the stale comment would:
1. Pass the `isVerified()` gate (stale bypass) ✓
2. Survive dedup ✓
3. Hit `getValidStatus()` which returns the "resolved" entry (hooks set it, hash relaxation lets it through)
4. Get re-dismissed at line 789 instead of re-analyzed ✗

The fix: `forceReanalyze = options.reverify || staleVerificationSet.has(item.comment.id)` bypasses `getValidStatus()` entirely for both `--reverify` and stale verifications.

## Files

| File | Role |
|---|---|
| `src/state/types.ts` | `CommentStatus` interface definition |
| `src/state/state-comment-status.ts` | Core status CRUD: markOpen, markResolved, getValidStatus, invalidateForFiles |
| `src/state/state-verification.ts` | Sync hooks in markVerified/unmarkVerified/clearAllVerifications |
| `src/state/state-dismissed.ts` | Sync hooks in dismissIssue/undismissIssue |
| `src/workflow/issue-analysis.ts` | Status cache integration in findUnresolvedIssues pipeline |
| `src/workflow/push-iteration-loop.ts` | invalidateForFiles call after verifyFixes |

## Lifecycle Paths

Nine paths through the system, all verified correct:

| # | Scenario | Outcome |
|---|---|---|
| 1 | New comment, LLM says "exists" | markOpen() → status cached with file hash |
| 2 | Open comment, fix verified | markVerified() hook → status flipped to resolved |
| 3 | Open comment, fix fails, file modified | invalidateForFiles() → status deleted → fresh LLM |
| 4 | Open comment, fix fails, file unchanged | Status hit → skip LLM (same answer anyway) |
| 5 | New comment, LLM says "already fixed" | markVerified() → no status entry exists → no-op |
| 6 | Comment dismissed (stale/exhausted) | dismissIssue() hook → status flipped to resolved |
| 7 | --reverify flag | forceReanalyze=true → bypasses status → fresh LLM |
| 7b | Stale verification (5+ iterations) | forceReanalyze=true → bypasses status → fresh LLM |
| 8 | clearAllVerifications (code changed) | Clears verifiedFixed, verifiedComments, AND commentStatuses |
| 9 | Resume after interruption | State loaded; unchanged files hit cache, changed files get fresh LLM |

## What This Does NOT Change

- Zero changes to the 15 `markVerified` call sites
- Zero changes to the 9 `dismissIssue` call sites
- Zero changes to the reporting layer (`reporter.ts`)
- No new imports in `state-verification.ts` or `state-dismissed.ts`
- `verifiedFixed` and `dismissedIssues` remain authoritative for reporting
- `commentStatuses` is purely an LLM analysis optimization layer
