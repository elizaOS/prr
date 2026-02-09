# Project Configuration

<!-- PRR_LESSONS_START -->
## PRR Lessons Learned

> Auto-synced from `.prr/lessons.md` - edit there for full history.

### Global

- When fixing corrupted generated content, sanitize the source before regenerating - fix the generator logic, not the symptoms.
- When a review requests fixing root-cause logic in code, locate and modify the actual function that generates the output.
- When a review requests function improvements, update the function itself, not just the data it processes.
- Treat unknown sync target state as "existed before" to prevent accidental data loss during cleanup.

### By File

**README.md**
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
