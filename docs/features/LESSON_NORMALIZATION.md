# Lesson normalization

Raw lesson text from fixers, batch verify, and no-changes handlers is normalized before it is stored in `.prr/lessons.md` or synced to CLAUDE.md / AGENTS.md. The design is **flexible on input, best-effort canonical form**: accept messy input and produce one consistent, dedupe-friendly string instead of rejecting.

## Why normalize

Lessons come from many sources:

- Batch verification (LLM says "NO: ..." with an explanation)
- Fixer no-changes output ("cursor made no changes: Issue already fixed...")
- Recovery and single-issue focus paths
- Manual or semi-structured paste from logs

Rejecting valid-but-messy input loses signal. Normalizing keeps lessons usable and deduplicatable without forcing every caller to pre-sanitize.

## Behavior (with WHYs)

### Preserve inline backticks

- **What**: Inline `` `code` `` (e.g. `` `execSync` ``, `` `tsc` ``) is left as-is. Only fenced code blocks (triple backticks) are removed.
- **WHY**: LLM explanations routinely use backticks for code references. Stripping them made lessons like "Use execSync with shell false" less readable and lost structure. Preserving them keeps lessons durable in Markdown.

### Keep normalized "made no changes"

- **What**: Standalone "tool made no changes" / "fixer made no changes" (with or without "without explanation", "trying different approach", "already includes...") are returned as a canonical string instead of `null`.
- **WHY**: These were previously rejected as "non-actionable". Callers still produce them; rejecting lost valid lessons and broke tests. Returning the normalized form allows storage and dedup; callers can filter later if needed.

### Canonicalize runner names and variants

- **What**: "codex made no changes", "42 made no changes", "claude-code ... made no changes - trying different approach" all become "tool made no changes" (or "tool made no changes without explanation - trying different approach" etc.). Repeated "tool made no changes, tool made no changes" collapses to one.
- **WHY**: Many phrasings mean the same thing; one canonical form avoids duplicate lessons and keeps `.prr/lessons.md` clean.

### Skip single-asterisk list lines

- **What**: When parsing line-by-line, lines that start with a single `*` (and not `**`) are skipped.
- **WHY**: In mixed lists ("1. item one", "- bullet", "* star"), the single-asterisk line is often noise. Keeping it added junk like "star" to the normalized text; skipping yields "item one item two bullet plus" without spurious tokens.

### Reject only clear non-lessons

- **What**: Truncation artifacts ("...", "contains", "the" at end), "chars truncated", "Fix for file:null", bare numbers, and infrastructure messages ("No verification result returned", "File was not modified") still return `null`.
- **WHY**: These are parsing or tool artifacts, not actionable lessons; storing them would pollute the lessons file.

## Where it runs

- `normalizeLessonText()` in `src/state/lessons-normalize.ts` is used when loading/saving lessons, adding a lesson from verify/fixer output, and when running `--tidy-lessons`.
- `lessonKey()` and `lessonNearKey()` use the same canonicalization ideas for dedup (e.g. two lessons that differ only by "codex" vs "tool" collapse to one key).

## See also

- CHANGELOG (lesson normalization entry under [Unreleased])
- `src/state/lessons-normalize.ts` (inline WHY comments)
- docs/ARCHITECTURE.md (Lessons section)
