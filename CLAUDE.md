# Project Configuration

<!-- PRR_LESSONS_START -->
## PRR Lessons Learned

> Auto-synced from `.prr/lessons.md` - edit there for full history.

### Global

- Fix for README.md rejected: The diff shows changes to line 576 about model listing commands, but the review requested verification and removal of unverified models like `gpt-5.2` and `Grok` from the table, which are not addressed
- Fix for src/logger.ts rejected: The change only reorders the type check condition but doesn't address the unused initial value of overallTotals mentioned in the review comment.
- Fix for src/resolver.ts rejected: The timeout reduction addresses one concern, but ignores the main security issues: no validation of working directory safety, no protection against shell injection, no use of Node.js APIs instead of execSync, and no process monitoring improvements.
- Fix for README.md rejected: The fix only adds a clarification comment and a generic link, but does not provide the platform-specific instructions (Linux, Intel Mac) that the review explicitly requested
- Fix for README.md rejected: The code change only reformats table formatting, but does not update the README example to match the canonical date-stamped model name from config.ts or add clarifying comments
- Fix for src/runners/llm-api.ts rejected: The diff does not match the review comment - it shows the same change as the first fix instead of implementing the ReDoS mitigation for the whitespace pattern on line 232. The suggested change to use `\s{1,1000}` is not present in the diff.
- Fix for .prr/lessons.md rejected: The fix removes malformed entries and deduplicated some lines, but the deduplication is incomplete. Many entries still contain
- Fix for CLAUDE.md rejected: The fix removes corrupted entries from CLAUDE.md, but does not address the root cause identified in the review comment—the lessons generation logic that produces these malformed entries. The CLAUDE.md file was manually cleaned, but the generator function that syncs from `.prr/lessons.md` and creates the malformed "Instructions" section was not identified or fixed, so the problem will recur.
- Review comment explicitly asks to "locate and modify the compaction function"—fix source code (compactLessons, dedupeLessons, etc. in src/state/man...
- Comment requests sanitization logic in the generator—identify the function that syncs .prr/lessons.md to CLAUDE.md and add stripping of parsing art...
- Comment asks for regex/trim logic in LessonsManager to strip " - ts" suffixes before saving—add this validation in the manager code, not...
- Comment asks to update normalizeLessonText to trim whitespace, collapse duplicate spaces with /\s{2,}/g, and detect orphan lines—modify the functio...
- Must implement the complete restoration strategy: add `originalRemoteUrl` variable, create `restoreRemote()` helper function, call it in ALL exit p...
- Isolate the fix to lines 1038–1052 only. Remove unrelated lesson normalization changes. Submit the `existedBefore`/`createdByPrr` logic change sepa...
- The suggested fix shows treating unknown entries (missing from map) as "existed before" to prevent data loss during cleanup. Instead, changes were ...
- _(124 more in .prr/lessons.md)_

### By File

**src/state/manager.ts**
- Fix for src/state/manager.ts:117 - When a requirement specifies "call X after Y", the fix must include the actual call statement, not just documentation describing it.
- Fix for src/state/manager.ts:384 rejected: The change modifies `clearInterrupted()` to be async and add a save call, but completely ignores the actual bug in `compactLessons()` that was described in the review comment. The fix addresses a different issue entirely.
- Fix for src/state/manager.ts:117 - tool made no changes
- tool made no changes - trying different approach
- fixer made no changes

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

**src/git/commit.ts**
- Fix for src/git/commit.ts:140 - tool modified wrong files (examples/feedback-loop-example.ts, src/resolver.ts, src/runners/cursor.ts), need to modify src/git/commit.ts
- Fix for src/git/commit.ts:389 - tool made no changes without explanation - trying different approach
- Fix for src/git/commit.ts:346 - tool made no changes without explanation - trying different approach

**src/llm/client.ts**
- Fix for src/llm/client.ts:115 rejected: The diff shows unrelated cleanup code instead of fixing the fixedIssues filter to use the full comments list rather than unresolvedIssues.
- Fix for src/llm/client.ts:319 - tool made no changes without explanation - trying different approach
- Fix for src/llm/client.ts:319 - The code after `Updated upstream` already has the fix with `allowedIds` validation, but the merge conflict needs to be cleaned up.

**src/cli.ts**
- Fix for src/cli.ts:133 rejected: The diff only adds parseIntOrExit for numeric validation but doesn't update the FixerTool type to include new runners ('claude-code', 'aider', 'codex', 'llm-api') or update validateTool() and CLI help text.
- Fix for src/cli.ts:151 - tool modified wrong files (src/config.ts, src/git/clone.ts, src/git/commit.ts, src/resolver.ts, src/runners/cursor.ts, src/state/manager.ts), need to modify src/cli.ts
- Fix for src/cli.ts:170 rejected: The diff only removes the `?? 400_000` fallback from `maxContextChars` but the comment indicates `maxStaleCycles` should also be changed to use nullish coalescing instead of `||`, which is missing from the diff.

**src/resolver.ts**
- Fix for src/resolver.ts:1035 - tool made no changes without explanation
- Fix for src/resolver.ts:2549 - tool made no changes without explanation - trying different approach

**src/runners/opencode.ts**
- Fix for src/runners/opencode.ts:93 - tool made no changes without explanation - trying different approach
- Fix for src/runners/opencode.ts:94 - When adding file creation, implement cleanup in all exit paths (resolve/reject/error) using try-finally or a cleanup callback to prevent leaks.

**src/config.ts**
- Fix for src/config.ts:61 - tool made no changes without explanation - trying different approach
- Fix for src/config.ts:168 rejected: The change only removes the mention of 'auto' from the error message but does not separate 'auto' validation from actual tool validation or document that 'auto' should be resolved before storage. The underlying issue—that 'auto' is checked alongside real tools—remains unaddressed.

**src/git/clone.ts**
- Fix for src/git/clone.ts:452 rejected: The diff adds merge completion logic but the merge abort on error path is missing—the suggested fix shows aborting merge on both conflict and generic error returns.

**CLAUDE.md**
- Fix for CLAUDE.md:94 - When fixing corrupted generated content, sanitize the source before regenerating, not just the output structure—fix the generator logic, not the symptoms.

**.prr/lessons.md**
- Fix for .prr/lessons.md:172 - When a review requests fixing root-cause logic in code, don't fix symptoms in output files—locate and modify the actual function (compactLessons, dedupeLessons, etc.) that generates the output.

**src/state/lessons.ts:305**
- Fix for src/state/lessons.ts:305 rejected: The diff removes extractPrrSection but also adds unrelated code to normalizeLessonText (access modifier check and extra cleaning), which goes beyond the stated requirement to remove only the unused method

**src/state/lessons.ts:359**
- Fix for src/state/lessons.ts:359 rejected: The diff removes extractPrrSection but adds unrelated normalization logic instead of adding direct unit tests for normalizeLessonText as requested in the review comment

**src/git/commit.ts:108**
- Fix for src/git/commit.ts:108 - Implement the `restoreRemote()` helper function first, then call it in all four exit paths (timeout, SIGINT, close, error handlers).

**tests/normalizeLessonText.test.ts:88**
- Fix for tests/normalizeLessonText.test.ts:88 - The fix must replace the actual test bodies with `it.todo(...)` or real assertions—removing imports alone doesn't address the no-op test cases.

**src/state/lessons.ts:930**
- Fix for src/state/lessons.ts:930 rejected: The code change does not include the logging fix. The diff shows unrelated changes to text normalization and sanitization logic, but does not show the catch block modification with console.warn that was proposed.

_(4 more files in .prr/lessons.md)_

<!-- PRR_LESSONS_END -->
