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

<!-- PRR_LESSONS_END -->
