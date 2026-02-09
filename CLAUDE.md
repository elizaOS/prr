# Project Configuration

<!-- PRR_LESSONS_START -->
## PRR Lessons Learned

> Auto-synced from `.prr/lessons.md` - edit there for full history.

### Global

- When fixing corrupted generated content, sanitize the source before regenerating - fix the generator logic, not the symptoms.
- When a review requests fixing root-cause logic in code, locate and modify the actual function that generates the output.
- When a review requests function improvements, update the function itself, not just the data it processes.
- Treat unknown sync target state as "existed before" to prevent accidental data loss during cleanup.
- When using `execSync`, always include `shell: false` option and pass command/args as array to prevent shell injection.
- When adding file creation, implement cleanup in all exit paths using try-finally or a cleanup callback to prevent leaks.
- When a requirement specifies "call X after Y", the fix must include the actual call statement, not just documentation.

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
