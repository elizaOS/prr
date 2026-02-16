# PR Context in Fix Prompts

## Problem

Fix prompts contained individual review comments with code snippets, but no information about what the PR was trying to accomplish. The fixer saw:

```text
## Issues to Fix
1. File: src/auth/handler.ts, Line 42
   "Error handling is incorrect — should propagate the auth failure, not swallow it"
```

Without context, the fixer might add generic error handling. But the PR was adding OAuth2 PKCE for mobile clients, and the correct fix involves propagating PKCE-specific error codes. The fix was technically valid but semantically wrong.

## Solution

Three additions to fix prompts:

### 1. PR Context Section

Inserted before the issues list so the fixer reads intent before specifics:

```text
## PR Context

**Title:** Add OAuth2 PKCE flow for mobile clients
**Description:** Implements RFC 7636 for native apps that can't securely store...
**Base branch:** main

Keep fixes aligned with this PR's intent.
```

### 2. Diff-First Instruction

Added as instruction #0 before "Address each issue":

```text
0. First, run `git diff main...HEAD --stat` to understand what this PR changes
```

### 3. Single-Issue Variant

When batch fixes fail and prr drops to single-issue mode, prompts include only the title and base branch (no description). WHY: Single-issue prompts need to be focused — a 500-char description would dilute attention from the one issue being fixed.

## Design Decisions

### WHY truncate description to 500 characters?

PR descriptions can include:
- Issue templates (hundreds of lines of checkboxes)
- Markdown tables of test results
- Embedded images (base64 or HTML `<img>` tags)
- Copy-pasted logs

Unbounded inclusion would consume tokens better spent on actual issues. 500 chars typically captures the first paragraph — the intent — without the template noise.

### WHY `--stat` not `--diff`?

`git diff --stat` produces a compact summary (filenames + line counts). A full `git diff` on a 30-file PR would be 10,000+ lines, overwhelming the context window. The stat view gives scope awareness — which files are touched and by how much — without the line-by-line detail.

### WHY `baseBranch` fallback to 'main'?

If `prInfo` is missing (shouldn't happen in normal flow, but defensive coding), the diff instruction falls back to `main`. Most repos use `main` as the default branch. An incorrect base in the diff instruction is a cosmetic issue — the fixer will see an empty diff and move on.

### WHY not include PR context in recovery prompts?

The emergency recovery path in `workflow/helpers/recovery.ts` uses a minimal inline template. This is a last-resort fallback when normal prompt building fails. Adding PR context there would increase the surface area of a code path that should be as simple and reliable as possible.

### WHY body is `string` not `string | null`?

GitHub's API returns `null` for PRs with no description. We coerce to `''` at the API boundary (`getPRInfo`) so every downstream consumer can simply check `if (body)` without null guards. This is a general pattern in prr: normalize API data at the boundary, not at each usage site.

## Files Modified

| File | Change | WHY |
|------|--------|-----|
| `src/github/types.ts` | Added `title`, `body` to `PRInfo` | Surface PR metadata already returned by API |
| `src/github/api.ts` | Fetch title/body in `getPRInfo()` | Populate new fields |
| `src/github/api.ts` | `greptile[bot]` in `REVIEW_BOTS` | Capture Greptile's issue-comment reviews |
| `src/github/api.ts` | `normalizeBotName()` | Clean display names in prompts |
| `src/analyzer/prompt-builder.ts` | PR Context section + diff instruction | Core prompt enhancement |
| `src/workflow/utils.ts` | PR context in single-issue prompts | Consistent context across prompt paths |
| `src/workflow/prompt-building.ts` | Thread `prInfo` parameter | Pass metadata from resolver to prompt builder |
| `src/workflow/execute-fix-iteration.ts` | Accept `prInfo` parameter | Pass metadata to prompt building |
| `src/workflow/push-iteration-loop.ts` | Pass `prInfo` to fix iteration | Wire metadata through the loop |
| `src/resolver.ts` | Pass `this.prInfo` to single-issue | Wire metadata to the fallback path |

## Pitfalls for Future Developers

1. **Do NOT add CodeRabbit to `REVIEW_BOTS`**: It uses inline review threads captured by `getReviewThreads()`. Its issue comment is a summary/walkthrough that would generate duplicate pseudo-issues.

2. **Do NOT normalize bot names in `getReviewThreads()`**: Raw logins like `coderabbitai[bot]` are used as identity keys for dedup and verification tracking. Normalizing them to `CodeRabbit` would break matching.

3. **The 17-parameter `executeFixIteration`**: `prInfo` was placed between `options: CLIOptions` and `verifiedThisSession: Set<string>` — three distinct types that tsc catches if swapped. An options-object refactor is planned but was deferred to keep this change minimal.
