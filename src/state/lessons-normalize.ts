/**
 * Lessons normalization: turn raw fixer/verifier text into durable, dedupe-friendly lesson strings.
 *
 * Design: be flexible on input and normalize to the best canonical form we can.
 * WHY: Lessons come from many sources (batch verify, no-changes explanation, recovery).
 * Rejecting valid-but-messy input loses signal; normalizing keeps lessons usable and
 * deduplicatable without forcing callers to pre-sanitize.
 */

export function normalizeLessonText(lesson: string): string | null {
  // Remove only fenced code blocks; leave inline `code` backticks intact.
  // WHY: Inline backticks (e.g. `execSync`, `tsc`) are durable documentation;
  // stripping them loses structure. Code fences are multi-line noise.
  let withoutFences = lesson.replace(/```[\s\S]*?```/g, '');
  const lines = withoutFences.split('\n');
  const kept: string[] = [];

  for (const line of lines) {
    let trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith('```') || trimmed.startsWith('#') || trimmed.startsWith('**')) continue;
    // Skip lines that start with a single asterisk (e.g. "* star" in mixed lists).
    // WHY: Single-* is often noise or comment-style; keeping it adds junk like "star"
    // to "item one item two bullet plus". Double-asterisk is bold, kept via content.
    if (trimmed.startsWith('*') && !trimmed.startsWith('**')) continue;
    trimmed = trimmed.replace(/^(?:[-*+]\s+|\d+\.\s+)/, '').trim();
    if (!trimmed) continue;
    if (/^\d+\.$/.test(trimmed)) continue;
    if (/^(?:\/\/|\/\*|\*)/.test(trimmed)) continue;
    if (/(^|\s)\/\/|\/\*|\*\//.test(trimmed)) continue;
    if (/^(?:public|private|protected)\s/.test(trimmed)) continue;
    if (/^[A-Za-z_$][\w$]*\s*(?::[^=;]+)?\s*(?:=|;)/.test(trimmed)) continue;
    if (/^(?:class|interface|type|enum|const|let|var|import|export)\b/.test(trimmed)) continue;
    kept.push(trimmed);
  }

  if (kept.length === 0) return null;

  let normalized = kept.join(' ');
  normalized = normalized.replace(/\s+/g, ' ').trim();
  normalized = normalized.replace(/^\s*-\s*/, '').trim();
  normalized = normalized.replace(/\s*\(inferred\)\s*/gi, ' ').trim();
  normalized = normalized.replace(/\s*-\s*\(inferred\)\s*\w+\b/gi, '').trim();
  normalized = normalized.replace(/\s*-\s*\(inferred\)[^\s]*/gi, '').trim();
  normalized = normalized.replace(/\s*-\s*:\s*(?:string|number|boolean|unknown|any)\s*;?/gi, ' - ').trim();
  // Insert missing separator between "made no changes" and "trying"/"already".
  // WHY: Fixer output often has "made no changestrying" or "made no changes  already";
  // normalizing to " - " gives one canonical form for dedup and display.
  normalized = normalized.replace(/made no changes\s*(?=trying)/gi, 'made no changes - ');
  normalized = normalized.replace(/made no changes\s*(?=already)/gi, 'made no changes - ');
  normalized = normalized.replace(/made no changes\s+already/gi, 'made no changes - already');
  normalized = normalized.replace(/made no changes\s*trying/gi, 'made no changes - trying');
  const alreadyIncludesMatch = normalized.match(/\balready includes[^.]*$/i);
  if (/\b:\s*(?:string|number|boolean|unknown|any)\s*;/.test(normalized)) {
    return null;
  }
  if (/\b[A-Za-z_$][\w$]*\s*(?::[^=;]+)?\s*(?:=|;)/.test(normalized)) {
    return null;
  }
  if (/\b(?:public|private|protected)\b\s+[A-Za-z_$][\w$]*\s*(?::[^;]+)?\s*(?:=|;)/i.test(normalized)) {
    return null;
  }
  normalized = normalized.replace(/\s*-\s*-\s*/g, ' - ').trim();
  normalized = normalized.replace(/\s*--+\s*/g, ' - ').trim();
  normalized = normalized.replace(/\s*-\s*[a-z]{1,5}:\d+$/i, '').trim();
  normalized = normalized.replace(/\s*-\s*(?:ts|tsx|js|jsx|md|json|yml|yaml)\b$/i, '').trim();
  normalized = normalized.replace(/(?<![\w.-])[a-z]{1,5}:\d+`?/gi, '').trim();
  normalized = normalized.replace(/(\.[a-z]{1,5}):(?:null|undefined)\b/gi, '$1').trim();
  normalized = normalized.replace(/^(Fix for\s+\S+)\.(?=\s)/i, '$1').trim();
  normalized = normalized.replace(/(?<!\.)[a-z]{1,5}:(?:null|undefined)\b/gi, '').trim();
  normalized = normalized.replace(/made no changes\s*:/i, 'made no changes');
  normalized = normalized.replace(/\bDo NOT repeat them\b:?/i, '').trim();
  normalized = canonicalizeToolAttempts(normalized);
  const fixForMatch = normalized.match(/^(Fix for\s+[^-]+)(?:\s+-\s+)?(.+)$/i);
  if (fixForMatch) {
    const prefix = fixForMatch[1].trim();
    const remainder = fixForMatch[2]?.trim();
    if (!remainder) {
      return null;
    }
    if (/made no changes/i.test(remainder)) {
      const isFixer = /fixer made no changes/i.test(remainder);
      const withoutExplanation = /without explanation/i.test(remainder);
      const tryingDifferent = /trying different approach/i.test(remainder);
      let message = isFixer ? 'fixer made no changes' : 'tool made no changes';
      if (withoutExplanation) message += ' without explanation';
      if (tryingDifferent) message += ' - trying different approach';
      if (alreadyIncludesMatch && !/already includes/i.test(message)) {
        message += ` - ${alreadyIncludesMatch[0].trim()}`;
      }
      normalized = `${prefix} - ${message}`;
    }
  }
  const toolAttemptMatch = normalized.match(/^(?:\d+-)?(?:claude-code|codex|llm-api|cursor|opencode|aider)\b.*\bmade no changes\b.*$/i);
  if (toolAttemptMatch) {
    const withoutExplanation = /without explanation/i.test(normalized);
    const tryingDifferent = /trying different approach/i.test(normalized);
    normalized = 'tool made no changes';
    if (withoutExplanation) normalized += ' without explanation';
    if (tryingDifferent) normalized += ' - trying different approach';
    if (alreadyIncludesMatch && !/already includes/i.test(normalized)) {
      normalized += ` - ${alreadyIncludesMatch[0].trim()}`;
    }
  }
  if (!/^Fix for\s+/i.test(normalized) && /\b(?:fixer|tool) made no changes\b/i.test(normalized)) {
    const isFixer = /fixer made no changes/i.test(normalized);
    const withoutExplanation = /without explanation/i.test(normalized);
    const tryingDifferent = /trying different approach/i.test(normalized);
    normalized = isFixer ? 'fixer made no changes' : 'tool made no changes';
    if (withoutExplanation) normalized += ' without explanation';
    if (tryingDifferent) normalized += ' - trying different approach';
    if (alreadyIncludesMatch && !/already includes/i.test(normalized)) {
      normalized += ` - ${alreadyIncludesMatch[0].trim()}`;
    }
  }
  // Canonicalize runner names and repeated "made no changes" into one token.
  // WHY: "codex made no changes", "42 made no changes", and "tool ... tool ..." all
  // mean the same for dedup; one canonical form avoids duplicate lessons.
  normalized = normalized.replace(/\b(?:\d+-)?(?:claude-code|codex|llm-api|cursor|opencode|aider)\b\s+made no changes(?:\s+without explanation)?(?:\s*-\s*trying different approach)?/gi, 'tool made no changes');
  normalized = normalized.replace(/\b\d+\s+made no changes(?:\s+without explanation)?(?:\s*-\s*trying different approach)?/gi, 'tool made no changes');
  normalized = normalized.replace(/(?:\btool made no changes\b(?:\s*(?:[-,;]|and)?\s*)?){2,}/gi, 'tool made no changes');
  normalized = normalized.replace(/(?:\bfixer made no changes\b(?:\s*(?:[-,;]|and)?\s*)?){2,}/gi, 'fixer made no changes');
  normalized = normalized.replace(/\s*:\s*$/, '').trim();
  normalized = normalized.replace(/\s+-\s*$/, '').trim();
  normalized = normalized.replace(/\s*(?:-\s*)?:\s*(?:string|number|boolean|unknown|any)\s*;?$/i, '').trim();
  normalized = normalized.replace(/\s{2,}/g, ' ').trim();
  if (!normalized) return null;
  if (/^\d+(?:\.\d+)?\.?$/.test(normalized)) return null;
  
  // Reject truncated or incomplete lessons (non-actionable fragments).
  // WHY: "...", "contains", or "the" at end are parsing/truncation artifacts;
  // short noun endings without action verbs are likely headers or fragments.
  if (/\.\.\.$/.test(normalized)) return null;
  if (/\b(?:in|to|for|from|with|the|and|or|but|if|when|that)\s*$/i.test(normalized)) return null;
  if (/\b(?:contain|contains|include|includes)\s*$/i.test(normalized)) return null;
  const endsWithIncompleteNoun = /(?:function|method|code|logic|generator|manager|strategy|helper|pattern|implementation)\s*$/i.test(normalized);
  const hasActionVerb = /\b(?:is|are|fix|avoid|implement|add|remove|update|use|handle|prevent|refactor|fixes|avoids|adds|check|ensure|validate|verify|create|delete|modify|change|apply|set|get|call|run|execute|skip|include|exclude)\b/i.test(normalized);
  if (endsWithIncompleteNoun && (normalized.length < 40 || !hasActionVerb)) return null;

  // Reject known malformed or non-actionable patterns.
  // WHY: "chars truncated", "Fix for file:null", and bare numbers are tool/parsing
  // artifacts, not lessons; storing them would pollute .prr/lessons.md.
  if (/\bchars\s+truncated\b/i.test(normalized)) return null;
  if (/^Fix for [^:]+:(?:null|undefined)\b/i.test(normalized)) return null;
  if (/^Fix for [^:]+:\d+$/i.test(normalized)) return null;
  if (/^Fix for [^:]+$/i.test(normalized)) return null;
  if (/^\d+\.?$/.test(normalized)) return null;
  if (/^Instructions\b/i.test(normalized)) return null;  // Reject header fragments
  
  // Reject non-actionable infrastructure messages
  // WHY: These describe parsing failures or tool issues, not how to fix code
  if (/\bNo verification result returned\b/i.test(normalized)) return null;
  if (/\btreating as failed\b/i.test(normalized)) return null;
  if (/\bFile was not modified\b/i.test(normalized)) return null;
  
  // Keep normalized "tool/fixer made no changes" instead of returning null.
  // WHY: Flexible input handling: we normalize to a canonical string so callers
  // can store and dedupe it. Rejecting these lost valid lessons from verify/fixer output.
  
  // Must have minimum substance (not just metadata)
  if (normalized.length < 20) return null;
  
  return normalized.length > 0 ? normalized : null;
}

/**
 * Stable key for a lesson for deduplication (case- and variant-insensitive).
 * WHY: Different phrasings ("codex made no changes", "tool made no changes - trying...")
 * should collapse to one key so we don't store duplicate lessons.
 */
export function lessonKey(lesson: string): string {
  let key = lesson.toLowerCase().replace(/\s+/g, ' ').trim();
  key = key.replace(/\btool made no changes\b(?:\s+without explanation)?(?:\s*-\s*trying different approach)?/g, 'tool made no changes');
  key = key.replace(/\bfixer made no changes\b(?:\s+without explanation)?(?:\s*-\s*trying different approach)?/g, 'fixer made no changes');
  key = key.replace(/\btool made no changes\b.*$/g, 'tool made no changes');
  key = key.replace(/\bfixer made no changes\b.*$/g, 'fixer made no changes');
  key = key.replace(/\b(?:\d+-)?(?:claude-code|codex|llm-api|cursor|opencode|aider)\b.*\bmade no changes\b.*$/g, 'tool made no changes');
  key = key.replace(/\b\d+\s+made no changes\b.*$/g, 'tool made no changes');
  key = key.replace(/\b([a-z0-9-]+) made no changes\b.*$/g, (_match, prefix) => {
    return prefix === 'fixer' ? 'fixer made no changes' : 'tool made no changes';
  });
  return key;
}

/**
 * Replace runner-prefixed "X with Y made no changes..." with canonical "tool made no changes...".
 * WHY: Same as lessonKey — many runners, one canonical form for display and dedup.
 */
export function canonicalizeToolAttempts(lesson: string): string {
  const toolPattern = '\\b(?:\\d+-)?(?:claude-code|codex|llm-api|cursor|opencode|aider)\\b';
  const attemptPattern = new RegExp(
    `${toolPattern}\\s+with\\s+.+?\\s+made no changes(?:\\s+without explanation)?(?:\\s*-\\s*trying different approach)?`,
    'gi'
  );
  return lesson.replace(attemptPattern, (match) => {
    const withoutExplanation = /without explanation/i.test(match);
    const tryingDifferent = /trying different approach/i.test(match);
    let canonical = 'tool made no changes';
    if (withoutExplanation) canonical += ' without explanation';
    if (tryingDifferent) canonical += ' - trying different approach';
    return canonical;
  });
}

export function sanitizeFilePathHeader(filePath: string): string {
  let cleaned = filePath.replace(/^#+\s*/, '').replace(/^\*\*|\*\*$/g, '').trim();
  
  // Strip all forms of " - (inferred) <language>" suffixes aggressively
  cleaned = cleaned.replace(/\s*-\s*\(inferred\).*$/i, '').trim();
  cleaned = cleaned.replace(/\s*-\s*\(inferred\)\s*\w+$/i, '').trim();
  // Review: consolidates suffix handling for clarity and consistency in formatting.
  cleaned = cleaned.replace(/\s*-\s*\(inferred\)\s*ts\b/i, '').trim();
  
  // Strip bare language suffixes like " - ts", " - tsx", etc.
  cleaned = cleaned.replace(/\s*-\s*(?:ts|tsx|js|jsx|md|json|yml|yaml|py|go|rs|java|c|cpp|h|hpp)\b$/i, '').trim();
  cleaned = cleaned.replace(/^.*?([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|md|json|yml|yaml|go|rs|py|java)(?::\d+)?).*$/i, '$1').trim();
  cleaned = cleaned.replace(/^(.*?:\d+)\s*-\s*\(inferred\).*$/i, '$1').trim();
  const inferredSuffixMatch = cleaned.match(/^(.*?\.(?:ts|tsx|js|jsx|md|json|yml|yaml|go|rs|py|java)(?::\d+)?)[\s-]*\(\s*inferred\s*\).*$/i);
  if (inferredSuffixMatch) {
    cleaned = inferredSuffixMatch[1].trim();
  }
  const fixForMatch = cleaned.match(/^Fix for\s+(.+?)(?:\s+(?:rejected:|-)\s+.*)?$/i);
  if (fixForMatch) {
    cleaned = fixForMatch[1].trim();
  }
  const inferredHeaderMatch = cleaned.match(/^(.*?:\d+)\s*-\s*\(inferred\).*$/i);
  if (inferredHeaderMatch) {
    cleaned = inferredHeaderMatch[1].trim();
  }
  cleaned = cleaned.replace(/\s*-\s*\(inferred\)\s*`?[a-z]+`?$/gi, '').trim();
  cleaned = cleaned.replace(/\s*-\s*\(inferred\)[^\n]*$/gi, '').trim();
  cleaned = cleaned.replace(/\s*\(inferred\)\s*/gi, ' ').trim();
  cleaned = cleaned.replace(/\s*\(inferred\)[^\n]*$/gi, '').trim();
  cleaned = cleaned.replace(/\s+-+\s+.*$/, '');
  if (cleaned.includes(' - ')) {
    cleaned = cleaned.split(' - ')[0].trim();
  }
  cleaned = cleaned.replace(/\s+(?:rejected:|failed:).*/i, '').trim();
  cleaned = cleaned.replace(/:(?:null|undefined)$/i, '');
  cleaned = cleaned.replace(/\s*\(inferred\).*$/, '').trim();
  cleaned = cleaned.replace(/\s*-\s*$/, '').trim();
  const headerMatch = cleaned.match(/([A-Za-z0-9_./-]+\.(?:ts|tsx|js|jsx|md|json|yml|yaml|go|rs|py|java))(?:[:](\d+)(?::\d+)?)?/i);
  if (headerMatch) {
    const pathPart = headerMatch[1];
    return pathPart;
  }
  return cleaned;
}

export function lessonNearKey(lesson: string): string {
  return lesson
    .toLowerCase()
    .replace(/\s*\(inferred\)\s*/g, ' ')
    .replace(/[^\w\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract significant tokens from a lesson for Jaccard similarity comparison.
 * Strips common stop words and short tokens to focus on meaningful content.
 */
export function lessonTokens(lesson: string): Set<string> {
  const STOP_WORDS = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'must', 'ought',
    'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
    'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'and', 'but', 'or', 'nor', 'not', 'so', 'yet', 'both', 'either',
    'neither', 'each', 'every', 'all', 'any', 'few', 'more', 'most',
    'other', 'some', 'such', 'than', 'too', 'very', 'just', 'also',
    'this', 'that', 'these', 'those', 'it', 'its',
    'fix', 'tool', 'fixer', 'file', 'files', 'code', 'change', 'changes',
    'instead', 'rather', 'only', 'use', 'using', 'when', 'make',
  ]);
  const words = lesson.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/);
  return new Set(words.filter(w => w.length > 2 && !STOP_WORDS.has(w)));
}

/**
 * Jaccard similarity between two token sets: |A∩B| / |A∪B|
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Similarity threshold above which two lessons are considered duplicates. */
export const LESSON_SIMILARITY_THRESHOLD = 0.6;

export function sanitizeLessonsList(lessons: string[]): string[] {
  const seenKeys = new Set<string>();
  const seenNear = new Set<string>();
  const result: string[] = [];
  // Token sets for Jaccard similarity — keeps the longest lesson on collision
  const keptTokens: Array<Set<string>> = [];
  
  for (const lesson of lessons) {
    const normalized = normalizeLessonText(lesson);
    if (!normalized) continue;
    const key = lessonKey(normalized);
    const nearKey = lessonNearKey(normalized);
    if (seenKeys.has(key) || seenNear.has(nearKey)) continue;

    // Semantic similarity check: compare against all kept lessons
    const tokens = lessonTokens(normalized);
    let isDuplicate = false;
    for (const existing of keptTokens) {
      if (jaccardSimilarity(tokens, existing) >= LESSON_SIMILARITY_THRESHOLD) {
        isDuplicate = true;
        break;
      }
    }
    if (isDuplicate) continue;

    seenKeys.add(key);
    seenNear.add(nearKey);
    keptTokens.push(tokens);
    result.push(normalized);
  }
  
  return result;
}

export function extractLessonFilePath(lesson: string): string | null {
  const match = lesson.match(/^Fix for\s+([^:]+(?::\d+)?)/i);
  if (match) {
    const pathWithLine = match[1].trim();
    const linePart = pathWithLine.match(/:(\d+)$/);
    return linePart ? pathWithLine.replace(/:\d+$/, '') : pathWithLine;
  }
  return null;
}

/** Expanded wording for the "tool made no changes" lesson so prompts and AAR show a clear instruction. */
const NO_CHANGES_EXPANDED =
  'Fixer made no edits and gave no explanation; try another model or strategy.';

export function formatLessonForDisplay(lesson: string): string {
  const match = lesson.match(/^Fix for [^:]+(?::\S+)? rejected: (.+)$/);
  if (match) {
    return match[1];
  }
  const noChangesMatch = lesson.match(/^Fix for [^:]+(?::\S+)? - (.+)$/);
  if (noChangesMatch) {
    const body = noChangesMatch[1].trim();
    if (/^(?:tool|fixer)\s+made no changes(?:\s+without explanation)?(?:\s*[-,]\s*trying different approach)?$/i.test(body)) {
      return NO_CHANGES_EXPANDED;
    }
    return body;
  }
  // Standalone (e.g. global) "tool/fixer made no changes without explanation - trying different approach"
  if (/^(?:tool|fixer)\s+made no changes(?:\s+without explanation)?(?:\s*[-,]\s*trying different approach)?$/i.test(lesson.trim())) {
    return NO_CHANGES_EXPANDED;
  }
  return lesson;
// Review: consolidates logic for streamlined handling of no changes in lessons.
}
