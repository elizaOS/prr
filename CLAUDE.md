# Project Configuration

<!-- PRR_LESSONS_START -->
## PRR Lessons Learned

> Auto-synced from `.prr/lessons.md` - edit there for full history.

### Global

- Fix for README.md:231 rejected: The diff updates model versions and rotation examples but doesn't fix the markdown indentation issues (MD005/MD007) in the nested list bullets under "Run Fixer".
- Fix for README.md:576 - tool modified wrong files (src/config.ts, src/git/clone.ts, src/git/commit.ts, src/resolver.ts, src/state/manager.ts), need to modify README.md
- Fix for README.md:1 - tool made no changes without explanation - trying different approach
- Fix for src/runners/claude-code.ts:156 rejected: The diff improves the permission error message but doesn't defer prompt file creation until after model validation or use a unique temporary filename to prevent collisions.
- Fix for src/runners/claude-code.ts:211 rejected: The diff is identical to the previous fixes and does not address the misleading error message. The error message should be updated to reflect whether skip-permissions is already enabled, but no such change is present.
- Fix for src/cli.ts:133 rejected: The diff only adds parseIntOrExit for numeric validation but doesn't update the FixerTool type to include new runners ('claude-code', 'aider', 'codex', 'llm-api') or update validateTool() and CLI help text.
- Fix for src/cli.ts:151 - tool modified wrong files (src/config.ts, src/git/clone.ts, src/git/commit.ts, src/resolver.ts, src/runners/cursor.ts, src/state/manager.ts), need to modify src/cli.ts
- Fix for src/cli.ts:170 rejected: The diff only removes the `?? 400_000` fallback from `maxContextChars` but the comment indicates `maxStaleCycles` should also be changed to use nullish coalescing instead of `||`, which is missing from the diff.
- Fix for src/git/clone.ts:452 rejected: The diff adds merge completion logic but the merge abort on error path is missing—the suggested fix shows aborting merge on both conflict and generic error returns.
- Fix for FIXER_EXPLANATION_REQUIREMENT.md:78 - md` file already have the correct template literal syntax with backticks.
- Fix for FIXER_EXPLANATION_REQUIREMENT.md:78 - tool made no changes
- Fix for src/config.ts:61 - tool made no changes without explanation - trying different approach
- Fix for src/config.ts:168 rejected: The change only removes the mention of 'auto' from the error message but does not separate 'auto' validation from actual tool validation or document that 'auto' should be resolved before storage. The underlying issue—that 'auto' is checked alongside real tools—remains unaddressed.
- Fix for CLAUDE.md:94 - When fixing corrupted generated content, sanitize the source before regenerating, not just the output structure—fix the generator logic, not the symptoms.
- Fix for .prr/lessons.md:172 - When a review requests fixing root-cause logic in code, don't fix symptoms in output files—locate and modify the actual function (compactLessons, dedupeLessons, etc.) that generates the output.
- _(81 more in .prr/lessons.md)_

### By File

**src/state/lessons.ts:305**
- Fix for src/state/lessons.ts:305 rejected: The diff removes extractPrrSection but also adds unrelated code to normalizeLessonText (access modifier check and extra cleaning), which goes beyond the stated requirement to remove only the unused method

**src/state/lessons.ts:359**
- Fix for src/state/lessons.ts:359 rejected: The diff removes extractPrrSection but adds unrelated normalization logic instead of adding direct unit tests for normalizeLessonText as requested in the review comment

**src/git/commit.ts:108**
- Fix for src/git/commit.ts:108 - Implement the `restoreRemote()` helper function first, then call it in all four exit paths (timeout, SIGINT, close, error handlers).

**tests/normalizeLessonText.test.ts:88**
- Fix for tests/normalizeLessonText.test.ts:88 - The fix must replace the actual test bodies with `it.todo(...)` or real assertions—removing imports alone doesn't address the no-op test cases.

<!-- PRR_LESSONS_END -->
