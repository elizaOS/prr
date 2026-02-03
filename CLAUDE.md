# Project Configuration

<!-- PRR_LESSONS_START -->
## PRR Lessons Learned

> Auto-synced from `.prr/lessons.md` - edit there for full history.

### Global

- Fix for README.md rejected: The fix only adds a clarification comment and a generic link, but does not provide the platform-specific instructions (Linux, Intel Mac) that the review explicitly requested
- Fix for README.md rejected: The code change only reformats table formatting, but does not update the README example to match the canonical date-stamped model name from config.ts or add clarifying comments
- Fix for src/runners/llm-api.ts rejected: The diff does not match the review comment - it shows the same change as the first fix instead of implementing the ReDoS mitigation for the whitespace pattern on line 232. The suggested change to use `\s{1,1000}` is not present in the diff.
- Fix for .prr/lessons.md rejected: The fix removes malformed entries and deduplicated some lines, but the deduplication is incomplete. Many entries still contain `
- Fix for CLAUDE.md rejected: The fix removes corrupted entries from CLAUDE.md, but does not address the root cause identified in the review comment—the lessons generation logic that produces these malformed entries. The CLAUDE.md file was manually cleaned, but the generator function that syncs from `.prr/lessons.md` and creates the malformed "Instructions" section was not identified or fixed, so the problem will recur.
- Fix for src/runners/llm-api.ts rejected: The fix adds redundant checks `relativePath === '..'` and `relativePath.startsWith(\`..${sep}\`)` which are already covered by the `hasParentTraversal` check that splits and tests for '..' segments
- Fix for src/runners/llm-api.ts rejected: The diff shown modifies the wrong section (isPathSafe logic) instead of the regex pattern on line 232 mentioned in the review comment
- Fix for src/runners/llm-api.ts rejected: The diff shown modifies the isPathSafe logic instead of removing the unused `join` import from the import statement
- Fix for src/runners/llm-api.ts rejected: The diff shows the opposite change - it replaces the simplified logic with the more complex condition that the review criticized as problematic
- Fix for src/runners/llm-api.ts rejected: The diff does not match the file or line numbers - it appears to be the same unrelated change from the first fix, not addressing the ReDoS vulnerability in the regex pattern
- Fix for src/runners/llm-api.ts rejected: The diff does not show the import statement being modified - it shows the same unrelated logic change, failing to remove the unused `join` import
- Fix for src/runners/llm-api.ts rejected: The logic change is incorrect. The original condition checks three things with OR, but the replacement `(fullPath !== workdirResolved && !fullPath.startsWith(workdirResolved + sep))` only checks two things and removes the parent traversal check from the combined condition, making it less safe.
- Fix for src/runners/llm-api.ts rejected: The diff shows the same lines being changed (189-192) as the first fix, but the comment references line 232 and a regex pattern change. The actual change needed to address the ReDoS vulnerability is not present in this diff.
- Fix for src/runners/llm-api.ts rejected: The code change shown is identical to the first fix and does not implement the ReDoS mitigation suggestion. The whitespace pattern limiting is not applied.
- Fix for src/runners/llm-api.ts rejected: The code change shown does not remove the `join` import; it appears to be the same diff from the first fix which doesn't address the unused import issue.
- _(42 more in .prr/lessons.md)_

### By File

**src/state/manager.ts**
- Fix for src/state/manager.ts:117 - When a requirement specifies "call X after Y", the fix must include the actual call statement, not just documentation describing it.
- Fix for src/state/manager.ts:384 rejected: The change modifies `clearInterrupted()` to be async and add a save call, but completely ignores the actual bug in `compactLessons()` that was described in the review comment. The fix addresses a different issue entirely.
- Fix for src/state/manager.ts:117 - tool made no changes
- tool made no changes - trying different approach
- fixer made no changes

**src/git/commit.ts**
- Fix for src/git/commit.ts:167 rejected: The diff calls `redactAuth()` function multiple times but never defines it; the helper function is missing from the code change, making the fix incomplete and non-functional.
- Fix for src/git/commit.ts:168 rejected: The diff is incomplete and only shows one error string redaction; missing the redactAuth function definition and redaction of debug statements for stdout/stderr/progress lines throughout the handlers.
- Fix for src/git/commit.ts:140 - tool modified wrong files (examples/feedback-loop-example.ts, src/resolver.ts, src/runners/cursor.ts), need to modify src/git/commit.ts
- Fix for src/git/commit.ts:389 - tool made no changes without explanation - trying different approach
- Fix for src/git/commit.ts:346 - tool made no changes without explanation - trying different approach

**src/state/lessons.ts**
- Fix for src/state/lessons.ts:613 rejected: The diff filters transient error patterns and marks repo lessons clean on success, but doesn't fix the Windows drive-letter path parsing issue in addLesson.
- Fix for src/state/lessons.ts:625 - Anchor the regex on message suffixes like " rejected:" or " - " to reliably separate filePath from line numbers, rather than relying solely on the last `:digits` pattern.
- Fix for src/state/lessons.ts:537 - Since the fix is already in place and the code matches the proposed solution, no changes are needed.
- Fix for src/state/lessons.ts:625 - Since the fix is already in place and the code matches the proposed solution, no changes are needed.

**src/runners/cursor.ts**
- Fix for src/runners/cursor.ts:31 rejected: The diff changes stdin handling but does not update the FALLBACK_MODELS array. The review comment specifically requested updating outdated model names in the fallback list at lines 24-31, which is not present in this diff.
- Fix for src/runners/cursor.ts:243 rejected: The diff changes stdin handling and prompt passing but does NOT move the prompt file from workdir to tmpdir as requested. The security issue about writing `.prr-prompt.txt` to the workspace and lacking cleanup is not addressed.
- Fix for src/runners/cursor.ts:256 rejected: The temp file is created but the isSafePath check is removed without replacement, and there is no cleanup logic (unlinkSync call) after the process completes.
- Fix for src/runners/cursor.ts:91 rejected: The fix duplicates the entire parsing loop instead of modifying the existing one, resulting in redundant code that processes lines twice.

**src/llm/client.ts**
- Fix for src/llm/client.ts:314 rejected: The diff adds ID validation but in the wrong file and with incomplete logic. The review comment is about `src/llm/client.ts` around lines 263-277; the diff shown is for `src/git/commit.ts`.
- Fix for src/llm/client.ts:115 rejected: The diff shows unrelated cleanup code instead of fixing the fixedIssues filter to use the full comments list rather than unresolvedIssues.
- Fix for src/llm/client.ts:319 - tool made no changes without explanation - trying different approach
- Fix for src/llm/client.ts:319 - The code after `Updated upstream` already has the fix with `allowedIds` validation, but the merge conflict needs to be cleaned up.

**README.md**
- Fix for README.md:573 rejected: The diff updates model versions but doesn't correct the CLI command (should be `agent models` or `cursor-agent - list-models`) or verify/update the gpt-5.2 and Grok model names.
- Fix for README.md:231 rejected: The diff updates model versions and rotation examples but doesn't fix the markdown indentation issues (MD005/MD007) in the nested list bullets under "Run Fixer".
- Fix for README.md:576 - tool modified wrong files (src/config.ts, src/git/clone.ts, src/git/commit.ts, src/resolver.ts, src/state/manager.ts), need to modify README.md
- Fix for README.md:1 - tool made no changes without explanation - trying different approach

**src/runners/claude-code.ts**
- Fix for src/runners/claude-code.ts:156 rejected: The diff improves the permission error message but doesn't defer prompt file creation until after model validation or use a unique temporary filename to prevent collisions.
- Fix for src/runners/claude-code.ts:211 rejected: The diff is identical to the previous fixes and does not address the misleading error message. The error message should be updated to reflect whether skip-permissions is already enabled, but no such change is present.
- tool made no changes - trying different approach
- fixer made no changes

**FIXER_EXPLANATION_REQUIREMENT.md**
- Fix for FIXER_EXPLANATION_REQUIREMENT.md:78 - md` file already have the correct template literal syntax with backticks.
- Fix for FIXER_EXPLANATION_REQUIREMENT.md:78 - tool made no changes
- tool made no changes - trying different approach
- fixer made no changes

**src/resolver.ts**
- Fix for src/resolver.ts:1035 - tool made no changes without explanation
- Fix for src/resolver.ts:523 rejected: The diff adds handling for changed files but doesn't implement the `resetChangedFiles()` helper or comprehensive revert logic. The review comment asks for a cleaner abstraction to revert unverified changes; the diff just adds one new branch.
- Fix for src/resolver.ts:2549 - tool made no changes without explanation - trying different approach

**src/cli.ts**
- Fix for src/cli.ts:133 rejected: The diff only adds parseIntOrExit for numeric validation but doesn't update the FixerTool type to include new runners ('claude-code', 'aider', 'codex', 'llm-api') or update validateTool() and CLI help text.
- Fix for src/cli.ts:151 - tool modified wrong files (src/config.ts, src/git/clone.ts, src/git/commit.ts, src/resolver.ts, src/runners/cursor.ts, src/state/manager.ts), need to modify src/cli.ts
- Fix for src/cli.ts:170 rejected: The diff only removes the `?? 400_000` fallback from `maxContextChars` but the comment indicates `maxStaleCycles` should also be changed to use nullish coalescing instead of `||`, which is missing from the diff.

**src/runners/opencode.ts**
- Fix for src/runners/opencode.ts:93 - tool made no changes without explanation - trying different approach
- Fix for src/runners/opencode.ts:94 - When adding file creation, implement cleanup in all exit paths (resolve/reject/error) using try-finally or a cleanup callback to prevent leaks.

**src/git/clone.ts**
- Fix for src/git/clone.ts:452 rejected: The diff adds merge completion logic but the merge abort on error path is missing—the suggested fix shows aborting merge on both conflict and generic error returns.
- Fix for src/git/clone.ts:501 rejected: The diff adds merge completion with `git.raw(['commit', ' - no-edit'])` but doesn't address the core issue. The review comment asks to either finalize or abort the merge; a non-interactive commit without conflict resolution may fail silently.

**src/config.ts**
- Fix for src/config.ts:61 - tool made no changes without explanation - trying different approach
- Fix for src/config.ts:168 rejected: The change only removes the mention of 'auto' from the error message but does not separate 'auto' validation from actual tool validation or document that 'auto' should be resolved before storage. The underlying issue—that 'auto' is checked alongside real tools—remains unaddressed.

**src/logger.ts**
- Fix for src/logger.ts:196 rejected: The diff doesn't address the review comment about variable naming inconsistency; it only removes an unused import and inlines the secs variable, which changes the code structure but doesn't fix the stated naming issue

**examples/feedback-loop-example.ts**
- Fix for examples/feedback-loop-example.ts:246 rejected: The diff is identical to the previous fix and shows the same duplicate imports problem; it doesn't properly show the replacement of the `require.main === module` check with the ESM-compatible pattern.

**CLAUDE.md**
- Fix for CLAUDE.md:94 - When fixing corrupted generated content, sanitize the source before regenerating, not just the output structure—fix the generator logic, not the symptoms.

**.prr/lessons.md**
- Fix for .prr/lessons.md:172 - When a review requests fixing root-cause logic in code, don't fix symptoms in output files—locate and modify the actual function (compactLessons, dedupeLessons, etc.) that generates the output.

**src/state/lessons.ts:305**
- Fix for src/state/lessons.ts:305 rejected: The diff removes extractPrrSection but also adds unrelated code to normalizeLessonText (access modifier check and extra cleaning), which goes beyond the stated requirement to remove only the unused method

**src/state/lessons.ts:359**
- Fix for src/state/lessons.ts:359 rejected: The diff removes extractPrrSection but adds unrelated normalization logic instead of adding direct unit tests for normalizeLessonText as requested in the review comment

<!-- PRR_LESSONS_END -->
