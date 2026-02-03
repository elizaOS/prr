# Project Configuration

<!-- PRR_LESSONS_START -->
## PRR Lessons Learned

> Auto-synced from `.prr/lessons.md` - edit there for full history.

### Global

- Fix for src/resolver.ts:null rejected: The timeout reduction addresses one concern, but ignores the main security issues: no validation of working directory safety, no protection against shell injection, no use of Node.js APIs instead of execSync, and no process monitoring improvements.
- codex with gpt-5.2-codex made no changes without explanation - trying different approach
- Fix for README.md:null rejected: The fix only adds a clarification comment and a generic link, but does not provide the platform-specific instructions (Linux, Intel Mac) that the review explicitly requested
- Fix for README.md:null rejected: The code change only reformats table formatting, but does not update the README example to match the canonical date-stamped model name from config.ts or add clarifying comments
- Fix for src/runners/cursor.ts:null - When a review specifies multiple implementation changes (remove X, set Y, write to Z), the fix must address ALL three—not just add related code. Check each requirement separately.
- codex with gpt-5.2-codex made no changes: Issue 1 is already fixed in `src/runners/llm-api.ts:228-236`. The whitespace regex is bounded via `const maxWhitespace = 1000;` and `const whitespacePattern = patternParts.join(\`\\s{1,${maxWhitespace}}\`);`, so it no longer uses unbounded `\\s+`.
- codex with gpt-5-mini made no changes: I did not change `README.md` because the current file already has a more descriptive title: `# prr (PR Resolver) - model rotation, lessons, and runner support` (see `README.md:1`), which matches the requested clarity in the review comment.
- codex with gpt-5-mini made no changes: Both requested issues are already fixed in the repository; no edits required.
- codex with gpt-5.2 made no changes: Both reported issues are already fixed in this workspace.
- codex with gpt-5-mini made no changes: Both issues are already fixed in the repo — no edits required.
- llm-api with claude-haiku-4-5-20251001 made no changes: Issue 1 cannot be fixed by editing source files. The review comment addresses the **PR title** which is git/GitHub metadata (commit message or GitHub PR title field), not content in README.md. PR titles are set via git commit messages or the GitHub PR web interface, not by modifying source code files in the repository. The README.md title "# prr (PR Resolver)" is the correct project name and should remain unchanged.
- Fix for src/runners/llm-api.ts:null rejected: The diff does not match the review comment - it shows the same change as the first fix instead of implementing the ReDoS mitigation for the whitespace pattern on line 232. The suggested change to use `\s{1,1000}` is not present in the diff.
- codex with gpt-5.2 made no changes: Issue 1 is already fixed in `src/runners/llm-api.ts:231-236` — the whitespace-normalized matching uses a bounded pattern with `const maxWhitespace = 1000;`, splitting on `new RegExp(\`\\\\s{1,${maxWhitespace}}\`)` and joining with ``\\s{1,${maxWhitespace}}``. There is no unbounded `\\s+` in the whitespace-normalized matcher at line 232, so applying the suggested change would be redundant.
- codex with gpt-5-mini made no changes: The ReDoS concern is already addressed in `src/runners/llm-api.ts` — the code bounds whitespace when building the normalized-search regex. See `src/runners/llm-api.ts:231-236` where `const maxWhitespace = 1000` is used and the pattern uses `\\s{1,${maxWhitespace}}` (the code splits on `new RegExp('\\s{1,1000}')` and joins with `\\s{1,1000}`), preventing an unbounded `\s+` match. No change required.
- codex with gpt-5-mini made no changes: Issue 1 is already fixed in the code — `src/runners/llm-api.ts:231` sets a bounded whitespace limit and constructs the regex with `\\s{1,${maxWhitespace}}` (see `const maxWhitespace = 1000;`, `searchNormalized.split(new RegExp(\`\\\\s{1,${maxWhitespace}}\`))`, and `patternParts.join(\`\\\\s{1,${maxWhitespace}}\`)`). This replaces any unbounded `\s+` with a bounded `\s{1,1000}`, mitigating the ReDoS concern, so no code change is required.
- _(107 more in .prr/lessons.md)_

### By File

**src/runners/claude-code.ts**
- Fix for src/runners/claude-code.ts:211 rejected: The diff is identical to the previous fixes and does not address the misleading error message. The error message should be updated to reflect whether skip-permissions is already enabled, but no such change is present.
- Fix for src/runners/claude-code.ts:232 - (inferred) - codex with gpt-5-mini made no changes: (inferred) Do NOT repeat them:

- claude-code with claude-sonnet-4-5-20250929 made no changes - trying different approach

- claude-code with claude-opus-4-5-20251101 made no changes: (inferred) ts:8` already includes all runners

- Fix for src/runners/claude-code.ts:232 - (inferred) - codex with gpt-5-mini made no changes: (inferred) Do NOT repeat them:
- claude-code with claude-sonnet-4-5-20250929 made no changes - trying different approach
- claude-code with claude-opus-4-5-20251101 made no changes: (inferred) ts:8` already includes all runners
- _(1 more)_

**src/state/manager.ts**
- Fix for src/state/manager.ts:117 - When a requirement specifies "call X after Y", the fix must include the actual call statement, not just documentation describing it.
- Fix for src/state/manager.ts:384 rejected: The change modifies `clearInterrupted()` to be async and add a save call, but completely ignores the actual bug in `compactLessons()` that was described in the review comment. The fix addresses a different issue entirely.
- Fix for src/state/manager.ts:117 - (inferred) - codex with gpt-5-mini made no changes: (inferred) Do NOT repeat them:
- claude-code with claude-sonnet-4-5-20250929 made no changes - trying different approach
- claude-code with claude-opus-4-5-20251101 made no changes: (inferred) ts:8` already includes all runners

**src/git/commit.ts**
- Fix for src/git/commit.ts:167 rejected: The diff calls `redactAuth()` function multiple times but never defines it; the helper function is missing from the code change, making the fix incomplete and non-functional.
- Fix for src/git/commit.ts:168 rejected: The diff is incomplete and only shows one error string redaction; missing the redactAuth function definition and redaction of debug statements for stdout/stderr/progress lines throughout the handlers.
- Fix for src/git/commit.ts:140 - tool modified wrong files (examples/feedback-loop-example.ts, src/resolver.ts, src/runners/cursor.ts), need to modify src/git/commit.ts
- Fix for src/git/commit.ts:389 - tool made no changes without explanation, trying different approach
- Fix for src/git/commit.ts:346 - tool made no changes without explanation, trying different approach

**src/resolver.ts**
- Fix for src/resolver.ts:1035 - tool made no changes without explanation, may need clearer instructions
- Fix for src/resolver.ts:null - tool made no changes without explanation, may need clearer instructions
- Fix for src/resolver.ts:523 rejected: The diff adds handling for changed files but doesn't implement the `resetChangedFiles()` helper or comprehensive revert logic. The review comment asks for a cleaner abstraction to revert unverified changes; the diff just adds one new branch.
- Fix for src/resolver.ts:2549 - tool made no changes without explanation, trying different approach

**src/runners/cursor.ts**
- Fix for src/runners/cursor.ts:31 rejected: The diff changes stdin handling but does not update the FALLBACK_MODELS array. The review comment specifically requested updating outdated model names in the fallback list at lines 24-31, which is not present in this diff.
- Fix for src/runners/cursor.ts:243 rejected: The diff changes stdin handling and prompt passing but does NOT move the prompt file from workdir to tmpdir as requested. The security issue about writing `.prr-prompt.txt` to the workspace and lacking cleanup is not addressed.
- Fix for src/runners/cursor.ts:256 rejected: The temp file is created but the isSafePath check is removed without replacement, and there is no cleanup logic (unlinkSync call) after the process completes.
- Fix for src/runners/cursor.ts:91 rejected: The fix duplicates the entire parsing loop instead of modifying the existing one, resulting in redundant code that processes lines twice.

**README.md**
- Fix for README.md:573 rejected: The diff updates model versions but doesn't correct the CLI command (should be `agent models` or `cursor-agent --list-models`) or verify/update the gpt-5.2 and Grok model names.
- Fix for README.md:231 rejected: The diff updates model versions and rotation examples but doesn't fix the markdown indentation issues (MD005/MD007) in the nested list bullets under "Run Fixer".
- Fix for README.md:576 - tool modified wrong files (src/config.ts, src/git/clone.ts, src/git/commit.ts, src/resolver.ts, src/state/manager.ts), need to modify README.md
- Fix for README.md:1 - tool made no changes without explanation, trying different approach

**FIXER_EXPLANATION_REQUIREMENT.md**
- Fix for FIXER_EXPLANATION_REQUIREMENT.md:78 - (inferred) md` file already have the correct template literal syntax with backticks.
- Fix for FIXER_EXPLANATION_REQUIREMENT.md:78 - (inferred) 2-codex made no changes: (inferred) Do NOT repeat them:
- claude-code with claude-sonnet-4-5-20250929 made no changes - trying different approach
- claude-code with claude-opus-4-5-20251101 made no changes: (inferred) ts:8` already includes all runners

**src/state/manager.ts:117**
- Fix for src/state/manager.ts:117 - (inferred) ts:117 - (inferred) - codex with gpt-5-mini made no changes: (inferred) Do NOT repeat them:
- claude-code with claude-sonnet-4-5-20250929 made no changes - trying different approach
- claude-code with claude-opus-4-5-20251101 made no changes: (inferred) ts:8` already includes all runners

**src/runners/claude-code.ts**
- Fix for src/runners/claude-code.ts:null - (inferred) ts:232 - (inferred) - codex with gpt-5-mini made no changes: (inferred) Do NOT repeat them:

- claude-code with claude-sonnet-4-5-20250929 made no changes - trying different approach

- claude-code with claude-opus-4-5-20251101 made no changes: (inferred) ts:8` already includes all runners

- Fix for src/runners/claude-code.ts:null - (inferred) ts:232 - (inferred) - codex with gpt-5-mini made no changes: (inferred) Do NOT repeat them:
- claude-code with claude-sonnet-4-5-20250929 made no changes - trying different approach
- claude-code with claude-opus-4-5-20251101 made no changes: (inferred) ts:8` already includes all runners

**src/runners/opencode.ts**
- Fix for src/runners/opencode.ts:93 - tool made no changes without explanation, trying different approach
- Fix for src/runners/opencode.ts:94 - When adding file creation, implement cleanup in all exit paths (resolve/reject/error) using try-finally or a cleanup callback to prevent leaks.
- Fix for src/runners/opencode.ts:103 - tool made no changes without explanation, trying different approach

**src/state/lessons.ts**
- Fix for src/state/lessons.ts:613 rejected: The diff filters transient error patterns and marks repo lessons clean on success, but doesn't fix the Windows drive-letter path parsing issue in addLesson.
- Fix for src/state/lessons.ts:625 - Anchor the regex on message suffixes like " rejected:" or " - " to reliably separate filePath from line numbers, rather than relying solely on the last `:digits` pattern.
- Fix for src/state/lessons.ts:537 - (inferred) Since the fix is already in place and the code matches the proposed solution, no changes are needed.

**src/llm/client.ts**
- Fix for src/llm/client.ts:314 rejected: The diff adds ID validation but in the wrong file and with incomplete logic. The review comment is about `src/llm/client.ts` around lines 263-277; the diff shown is for `src/git/commit.ts`.
- Fix for src/llm/client.ts:115 rejected: The diff shows unrelated cleanup code instead of fixing the fixedIssues filter to use the full comments list rather than unresolvedIssues.
- Fix for src/llm/client.ts:319 - tool made no changes without explanation, trying different approach

**src/cli.ts**
- Fix for src/cli.ts:133 rejected: The diff only adds parseIntOrExit for numeric validation but doesn't update the FixerTool type to include new runners ('claude-code', 'aider', 'codex', 'llm-api') or update validateTool() and CLI help text.
- Fix for src/cli.ts:151 - tool modified wrong files (src/config.ts, src/git/clone.ts, src/git/commit.ts, src/resolver.ts, src/runners/cursor.ts, src/state/manager.ts), need to modify src/cli.ts
- Fix for src/cli.ts:170 rejected: The diff only removes the `?? 400_000` fallback from `maxContextChars` but the comment indicates `maxStaleCycles` should also be changed to use nullish coalescing instead of `||`, which is missing from the diff.

**src/logger.ts**
- Fix for src/logger.ts:null - tool made no changes without explanation, may need clearer instructions
- Fix for src/logger.ts:196 rejected: The diff doesn't address the review comment about variable naming inconsistency; it only removes an unused import and inlines the secs variable, which changes the code structure but doesn't fix the stated naming issue

**src/git/clone.ts**
- Fix for src/git/clone.ts:452 rejected: The diff adds merge completion logic but the merge abort on error path is missing—the suggested fix shows aborting merge on both conflict and generic error returns.
- Fix for src/git/clone.ts:501 rejected: The diff adds merge completion with `git.raw(['commit', '--no-edit'])` but doesn't address the core issue. The review comment asks to either finalize or abort the merge; a non-interactive commit without conflict resolution may fail silently.

**examples/feedback-loop-example.ts**
- Fix for examples/feedback-loop-example.ts:25 - tool made no changes without explanation, trying different approach
- Fix for examples/feedback-loop-example.ts:246 rejected: The diff is identical to the previous fix and shows the same duplicate imports problem; it doesn't properly show the replacement of the `require.main === module` check with the ESM-compatible pattern.

**src/config.ts**
- Fix for src/config.ts:61 - tool made no changes without explanation, trying different approach

**src/state/lessons.ts:625**
- Fix for src/state/lessons.ts:625 - (inferred) ts:537 - (inferred) Since the fix is already in place and the code matches the proposed solution, no changes are needed.

**FIXER_EXPLANATION_REQUIREMENT.md:78**
- Fix for FIXER_EXPLANATION_REQUIREMENT.md:78 - (inferred) md:78 - (inferred) md` file already have the correct template literal syntax with backticks.

**src/llm/client.ts:319**
- Fix for src/llm/client.ts:319 - (inferred) ts:319 - (inferred) The code after `Updated upstream` already has the fix with `allowedIds` validation, but the merge conflict needs to be cleaned up.

_(1 more files in .prr/lessons.md)_

<!-- PRR_LESSONS_END -->
