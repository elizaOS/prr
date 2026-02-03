import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

/**
 * Format a lesson for display by stripping the redundant prefix.
 * Internal format: "Fix for path/file.ext:line rejected: actual lesson content"
 * Display format: "actual lesson content"
 * 
 * WHY: The prefix is needed internally for scoping (extracting file path),
 * but when showing to users/LLMs, only the actual lesson matters.
 */
export function formatLessonForDisplay(lesson: string): string {
  // Strip "Fix for path:line rejected: " prefix if present
  const match = lesson.match(/^Fix for [^:]+(?::\S+)? rejected: (.+)$/);
  if (match) {
    return match[1];
  }
  // Also handle "tool made no changes" format
  const noChangesMatch = lesson.match(/^Fix for [^:]+(?::\S+)? - (.+)$/);
  if (noChangesMatch) {
    return noChangesMatch[1];
  }
  return lesson;
}

export interface LessonsStore {
  owner: string;
  repo: string;
  branch: string;
  lastUpdated: string;
  global: string[];           // Lessons that apply to all files
  files: Record<string, string[]>;  // File path -> lessons for that file
}

/**
 * Get path to machine-local lessons JSON file.
 * WHY: This stores machine-specific lessons that may not be relevant to share.
 */
function getLocalLessonsPath(owner: string, repo: string, branch: string): string {
  // Sanitize branch name for filesystem
  const safeBranch = branch.replace(/[/\\:*?"<>|]/g, '_');
  return join(homedir(), '.prr', 'lessons', owner, repo, `${safeBranch}.json`);
}

/**
 * Sync targets - files where we inject a lessons section.
 * WHY: Different AI tools read different files.
 * We preserve existing content and only update our delimited section.
 */
export type LessonsSyncTarget = 'claude-md' | 'conventions-md' | 'cursor-rules';

interface SyncTargetConfig {
  path: (workdir: string) => string;
  description: string;
  tools: string[];
  createHeader?: string;  // Header for new files
}

const SYNC_TARGETS: Record<LessonsSyncTarget, SyncTargetConfig> = {
  'claude-md': {
    path: (workdir) => join(workdir, 'CLAUDE.md'),
    description: 'CLAUDE.md',
    tools: ['Cursor', 'Claude Code'],
    createHeader: '# Project Configuration\n\n',
  },
  'conventions-md': {
    path: (workdir) => join(workdir, 'CONVENTIONS.md'),
    description: 'CONVENTIONS.md',
    tools: ['Aider'],
    createHeader: '# Coding Conventions\n\n',
  },
  'cursor-rules': {
    path: (workdir) => join(workdir, '.cursor', 'rules', 'prr-lessons.mdc'),
    description: '.cursor/rules/',
    tools: ['Cursor'],
    createHeader: '',  // No header for Cursor rules
  },
};

/**
 * Get path to our canonical lessons file.
 * WHY: .prr/lessons.md is fully managed by prr - we control the entire file.
 */
function getPrrLessonsPath(workdir: string): string {
  return join(workdir, '.prr', 'lessons.md');
}

// Delimiter for prr lessons section in OTHER files (CLAUDE.md, etc.)
// WHY: We only update our section, preserving user's existing content
const PRR_SECTION_START = '<!-- PRR_LESSONS_START -->';
const PRR_SECTION_END = '<!-- PRR_LESSONS_END -->';

// Size limits for synced files (CLAUDE.md, etc.) to prevent bloat
// Our canonical .prr/lessons.md has no limits
const MAX_GLOBAL_LESSONS_FOR_SYNC = 15;
const MAX_FILE_LESSONS_FOR_SYNC = 5;
const MAX_FILES_FOR_SYNC = 20;

export class LessonsManager {
  private store: LessonsStore;
  private localStorePath: string;
  private workdir: string | null = null;
  private dirty = false;
  private repoLessonsDirty = false;
  private syncTargets: LessonsSyncTarget[] = ['claude-md'];  // Default sync targets
  
  // Track new lessons added this session
  // WHY: Distinguishes "22 lessons learned" (existing) from "22 lessons (5 new)"
  // Helps users understand if progress is being made vs. just carrying old lessons
  private initialLessonCount = 0;
  private newLessonsThisSession = 0;

  constructor(owner: string, repo: string, branch: string) {
    this.localStorePath = getLocalLessonsPath(owner, repo, branch);
    this.store = {
      owner,
      repo,
      branch,
      lastUpdated: new Date().toISOString(),
      global: [],
      files: {},
    };
  }

  /**
   * Set the workdir to enable repo-based lesson sharing.
   * WHY: Repo lessons allow team coordination and long-term learning.
   */
  setWorkdir(workdir: string): void {
    this.workdir = workdir;
    // Auto-detect which sync targets to use based on existing files
    this.autoDetectSyncTargets();
  }

  /**
   * Set which files to sync lessons to.
   * WHY: Different teams use different AI tools.
   */
  setSyncTargets(targets: LessonsSyncTarget[]): void {
    this.syncTargets = targets;
  }

  /**
   * Auto-detect sync targets based on existing files in repo.
   * WHY: If user already has CONVENTIONS.md or .cursor/rules/, sync there too.
   */
  private autoDetectSyncTargets(): void {
    if (!this.workdir) return;

    const detected: LessonsSyncTarget[] = [];

    // Always sync to CLAUDE.md (Cursor + Claude Code both read it)
    detected.push('claude-md');

    // Check for Aider's CONVENTIONS.md or config
    if (existsSync(join(this.workdir, 'CONVENTIONS.md')) ||
        existsSync(join(this.workdir, '.aider.conf.yml'))) {
      detected.push('conventions-md');
    }

    // Check for Cursor native rules directory
    if (existsSync(join(this.workdir, '.cursor', 'rules'))) {
      detected.push('cursor-rules');
    }

    this.syncTargets = [...new Set(detected)];  // Dedupe
  }

  async load(): Promise<void> {
    // Load local (machine-specific) lessons first
    await this.loadLocalLessons();

    // Load and merge lessons from repo's .prr/lessons.md (canonical source)
    if (this.workdir) {
      await this.loadPrrLessons();
    }

    // Report loaded lessons
    const globalCount = this.store.global.length;
    const fileCount = Object.keys(this.store.files).length;
    const fileLessonCount = Object.values(this.store.files).reduce((sum, arr) => sum + arr.length, 0);

    // Track initial count to distinguish new lessons this session
    this.initialLessonCount = globalCount + fileLessonCount;
    this.newLessonsThisSession = 0;  // Reset for this session

    if (globalCount > 0 || fileLessonCount > 0) {
      console.log(`Loaded lessons: ${globalCount} global, ${fileLessonCount} file-specific (${fileCount} files)`);
    }
  }

  private async loadLocalLessons(): Promise<void> {
    if (existsSync(this.localStorePath)) {
      try {
        const content = await readFile(this.localStorePath, 'utf-8');
        const loaded = JSON.parse(content) as LessonsStore;

        // Validate it's for the same branch
        if (loaded.owner === this.store.owner &&
            loaded.repo === this.store.repo &&
            loaded.branch === this.store.branch) {
          this.store = loaded;

          // Prune transient/stale lessons on load
          const prunedTransient = this.pruneTransientLessons();
          if (prunedTransient > 0) {
            console.log(`Pruned ${prunedTransient} stale/transient lessons`);
            this.dirty = true;
          }
          
          // Strip model names from lessons (we track model stats separately)
          const sanitizedModels = this.sanitizeModelNames();
          if (sanitizedModels > 0) {
            console.log(`Sanitized ${sanitizedModels} lessons (removed model names)`);
          }
          
          // Prune lessons with relative references (Issue 1, Issue 2, etc.)
          const prunedRelative = this.pruneRelativeLessons();
          if (prunedRelative > 0) {
            console.log(`Pruned ${prunedRelative} lessons with relative references`);
          }
        }
      } catch (error) {
        console.warn('Failed to load local lessons file, starting fresh:', error);
      }
    }
  }

  /**
   * Load lessons from repo's .prr/lessons.md (canonical source).
   * WHY: This is the file we fully control - team shares lessons via this file.
   */
  private async loadPrrLessons(): Promise<void> {
    if (!this.workdir) return;

    const prrLessonsPath = getPrrLessonsPath(this.workdir);
    if (!existsSync(prrLessonsPath)) return;

    try {
      const content = await readFile(prrLessonsPath, 'utf-8');
      const repoLessons = this.parseMarkdownLessons(content);
      let merged = 0;

      // Merge global lessons
      for (const lesson of repoLessons.global) {
        if (!this.store.global.includes(lesson)) {
          this.store.global.push(lesson);
          merged++;
        }
      }

      // Merge file-specific lessons
      for (const [path, lessons] of Object.entries(repoLessons.files)) {
        if (!this.store.files[path]) {
          this.store.files[path] = [];
        }
        for (const lesson of lessons) {
          if (!this.store.files[path].includes(lesson)) {
            this.store.files[path].push(lesson);
            merged++;
          }
        }
      }

      if (merged > 0) {
        console.log(`Merged ${merged} lessons from .prr/lessons.md`);
      }
    } catch (error) {
      console.warn('Failed to load .prr/lessons.md:', error);
    }
  }

  /**
   * Extract the prr lessons section from a file's content.
   */
  private extractPrrSection(content: string): string | null {
    const startIdx = content.indexOf(PRR_SECTION_START);
    const endIdx = content.indexOf(PRR_SECTION_END);

    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
      return null;
    }

    return content.slice(startIdx + PRR_SECTION_START.length, endIdx).trim();
  }

  /**
   * Parse markdown lessons file into structured data.
   *
   * Expected format:
   * # PRR Lessons Learned
   *
   * ## Global Lessons
   * - Lesson text here
   *
   * ## File-Specific Lessons
   * ### path/to/file.ts
   * - Lesson for this file
   */
  private parseMarkdownLessons(content: string): { global: string[]; files: Record<string, string[]> } {
    const result: { global: string[]; files: Record<string, string[]> } = {
      global: [],
      files: {},
    };

    const lines = content.split('\n');
    let currentSection: 'none' | 'global' | 'file' = 'none';
    let currentFile: string | null = null;

    for (const line of lines) {
      const trimmed = line.trim();

      // Section headers
      if (trimmed === '## Global Lessons') {
        currentSection = 'global';
        currentFile = null;
        continue;
      }
      if (trimmed === '## File-Specific Lessons') {
        currentSection = 'file';
        currentFile = null;
        continue;
      }

      // File path header (### path/to/file.ts)
      if (currentSection === 'file' && trimmed.startsWith('### ')) {
        currentFile = trimmed.slice(4).trim();
        if (!result.files[currentFile]) {
          result.files[currentFile] = [];
        }
        continue;
      }

      // Lesson item (- Lesson text)
      if (trimmed.startsWith('- ')) {
        const lesson = trimmed.slice(2).trim();
        if (lesson.length > 0) {
          if (currentSection === 'global') {
            result.global.push(lesson);
          } else if (currentSection === 'file' && currentFile) {
            result.files[currentFile].push(lesson);
          }
        }
      }
    }

    return result;
  }

  /**
   * Export lessons to markdown format for repo sharing.
   */
  private toMarkdown(): string {
    const lines: string[] = [
      '# PRR Lessons Learned',
      '',
      '> This file is auto-generated by [prr](https://github.com/elizaOS/prr).',
      '> It contains lessons learned from PR review fixes to help improve future fix attempts.',
      '> You can edit this file manually or let prr update it.',
      '> To share lessons across your team, commit this file to your repo.',
      '',
    ];

    // Global lessons
    if (this.store.global.length > 0) {
      lines.push('## Global Lessons');
      lines.push('');
      for (const lesson of this.store.global) {
        lines.push(`- ${lesson}`);
      }
      lines.push('');
    }

    // File-specific lessons
    const fileEntries = Object.entries(this.store.files).filter(([, lessons]) => lessons.length > 0);
    if (fileEntries.length > 0) {
      lines.push('## File-Specific Lessons');
      lines.push('');

      for (const [filePath, lessons] of fileEntries.sort((a, b) => a[0].localeCompare(b[0]))) {
        lines.push(`### ${filePath}`);
        lines.push('');
        for (const lesson of lessons) {
          lines.push(`- ${lesson}`);
        }
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  /**
   * Remove transient lessons that aren't actionable for future fixes
   * WHY: Tool failures (connection, model unavailable) pollute lessons and aren't helpful
   */
  private pruneTransientLessons(): number {
    const transientPatterns = [
      /failed: Cannot use this model/i,      // Model availability issues
      /failed: Connection/i,                  // Connection issues
      /failed: timeout/i,                     // Timeout issues
      /failed: ECONNREFUSED/i,               // Connection refused
      /failed: ETIMEDOUT/i,                  // Connection timeout
      /failed: rate limit/i,                 // Rate limiting
      /failed: 5\d{2}/i,                     // 5xx server errors
      /failed: 408/i,                        // Request timeout (transient)
      /failed: 429/i,                        // Rate limit (transient)
      /tool made no changes, may need clearer/i,  // Generic "no changes" - not actionable
    ];

    let pruned = 0;

    // Prune global lessons
    const originalGlobalCount = this.store.global.length;
    this.store.global = this.store.global.filter(lesson => {
      const isTransient = transientPatterns.some(pattern => pattern.test(lesson));
      return !isTransient;
    });
    pruned += originalGlobalCount - this.store.global.length;

    // Prune file-specific lessons
    for (const filePath of Object.keys(this.store.files)) {
      const originalCount = this.store.files[filePath].length;
      this.store.files[filePath] = this.store.files[filePath].filter(lesson => {
        const isTransient = transientPatterns.some(pattern => pattern.test(lesson));
        return !isTransient;
      });
      pruned += originalCount - this.store.files[filePath].length;

      // Remove empty file entries
      if (this.store.files[filePath].length === 0) {
        delete this.store.files[filePath];
      }
    }

    return pruned;
  }

  /**
   * Strip tool/model names from lessons - we track model performance separately.
   * WHY: Lessons like "codex with gpt-5-mini made no changes: ..." duplicate
   * the model stats we already track. The actual content is what matters.
   */
  private sanitizeModelNames(): number {
    let sanitized = 0;

    // Pattern to match tool/model prefixes like "llm-api with claude-haiku-4-5-20251001 made no changes: "
    // or "codex with gpt-5.2 made no changes: "
    const modelPrefixPattern = /^(?:llm-api|codex|cursor|claude-code|aider|opencode)\s+(?:with\s+[\w.-]+\s+)?made no changes:\s*/i;

    // Sanitize global lessons
    this.store.global = this.store.global.map(lesson => {
      const sanitizedLesson = lesson.replace(modelPrefixPattern, 'Fixer made no changes: ');
      if (sanitizedLesson !== lesson) {
        sanitized++;
        this.dirty = true;
      }
      return sanitizedLesson;
    });

    // Sanitize file-specific lessons
    for (const filePath of Object.keys(this.store.files)) {
      this.store.files[filePath] = this.store.files[filePath].map(lesson => {
        const sanitizedLesson = lesson.replace(modelPrefixPattern, 'Fixer made no changes: ');
        if (sanitizedLesson !== lesson) {
          sanitized++;
          this.dirty = true;
        }
        return sanitizedLesson;
      });
    }

    return sanitized;
  }

  /**
   * Remove lessons that contain relative/temporary references.
   * WHY: Lessons like "Issue 1 is already fixed" are useless because "Issue 1"
   * changes between runs. These need absolute anchors (file:line).
   */
  private pruneRelativeLessons(): number {
    // Patterns that indicate a relative reference (useless across runs)
    const relativePatterns = [
      /\bIssue\s*\d+\b/i,          // "Issue 1", "issue 2"
      /\bissue_\d+\b/i,            // "issue_1", "issue_2"
      /\b#\d+\s+(?:is|has|was)/i,  // "#1 is already fixed"
      /\bfirst\s+issue\b/i,        // "first issue"
      /\bsecond\s+issue\b/i,       // "second issue"
    ];

    let pruned = 0;

    // Prune global lessons with relative refs (but keep if they also have file:line)
    const originalGlobalCount = this.store.global.length;
    this.store.global = this.store.global.filter(lesson => {
      // If it has an absolute anchor (file:line), keep it even with relative refs
      if (/\w+\.(ts|js|py|rs|go|java|tsx|jsx):\d+/.test(lesson)) {
        return true;
      }
      // Otherwise, prune if it has relative references
      const hasRelativeRef = relativePatterns.some(pattern => pattern.test(lesson));
      return !hasRelativeRef;
    });
    pruned += originalGlobalCount - this.store.global.length;

    // File-specific lessons already have absolute anchors, but prune pure relative refs
    for (const filePath of Object.keys(this.store.files)) {
      const originalCount = this.store.files[filePath].length;
      this.store.files[filePath] = this.store.files[filePath].filter(lesson => {
        // Check if the lesson is ONLY about a relative ref with no actual content
        const relativeOnly = relativePatterns.some(pattern => {
          const match = lesson.match(pattern);
          if (!match) return false;
          // If the lesson is mostly just "Issue X is fixed", prune it
          return lesson.length < 100 && pattern.test(lesson);
        });
        return !relativeOnly || /\w+\.(ts|js|py|rs|go|java|tsx|jsx):\d+/.test(lesson);
      });
      pruned += originalCount - this.store.files[filePath].length;

      if (this.store.files[filePath].length === 0) {
        delete this.store.files[filePath];
      }
    }

    if (pruned > 0) {
      this.dirty = true;
    }

    return pruned;
  }

  /**
   * Remove lessons for files that no longer exist in the repo.
   * WHY: Lessons about deleted files/functions are useless and clutter the context.
   * 
   * @param workdir - Working directory to check file existence
   * @returns Number of lessons pruned
   */
  pruneDeletedFiles(workdir: string): number {
    let pruned = 0;

    // Prune file-specific lessons for deleted files
    for (const filePath of Object.keys(this.store.files)) {
      const fullPath = join(workdir, filePath);
      if (!existsSync(fullPath)) {
        pruned += this.store.files[filePath].length;
        delete this.store.files[filePath];
        this.dirty = true;
      }
    }

    // Prune global lessons that reference specific deleted files
    // Pattern: "Fix for path/to/file.ts:123 ..."
    const originalGlobalCount = this.store.global.length;
    this.store.global = this.store.global.filter(lesson => {
      const fileMatch = lesson.match(/^Fix for ([^:]+)(?::\d+)?/);
      if (fileMatch) {
        const filePath = fileMatch[1];
        const fullPath = join(workdir, filePath);
        if (!existsSync(fullPath)) {
          return false; // File doesn't exist, prune this lesson
        }
      }
      return true; // Keep lesson
    });
    
    if (this.store.global.length < originalGlobalCount) {
      pruned += originalGlobalCount - this.store.global.length;
      this.dirty = true;
    }

    return pruned;
  }

  async save(): Promise<void> {
    // Save local lessons (machine-specific JSON)
    if (this.dirty) {
      this.store.lastUpdated = new Date().toISOString();

      // Ensure directory exists
      const dir = dirname(this.localStorePath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }

      await writeFile(this.localStorePath, JSON.stringify(this.store, null, 2), 'utf-8');
      this.dirty = false;
    }
  }

  /**
   * Save lessons to repo files.
   * 
   * Two-tier approach:
   * 1. .prr/lessons.md - FULL lessons (we control this file completely)
   * 2. CLAUDE.md, etc. - COMPACTED lessons in a delimited section (preserves user content)
   * 
   * WHY: .prr/ is our directory, but CLAUDE.md may have user content we shouldn't touch.
   */
  async saveToRepo(): Promise<boolean> {
    if (!this.workdir) {
      console.warn('Cannot save to repo: workdir not set');
      return false;
    }

    let success = false;

    // 1. Save FULL lessons to .prr/lessons.md (canonical source)
    try {
      const prrLessonsPath = getPrrLessonsPath(this.workdir);
      const dir = dirname(prrLessonsPath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }

      const fullMarkdown = this.toMarkdown();
      await writeFile(prrLessonsPath, fullMarkdown, 'utf-8');
      const total = this.getTotalCount();
      const newCount = this.newLessonsThisSession;
      const saveMsg = newCount > 0 
        ? `Saved ${total} lessons to .prr/lessons.md (${newCount} new this run)`
        : `Saved ${total} lessons to .prr/lessons.md (no new lessons)`;
      console.log(saveMsg);
      success = true;
    } catch (error) {
      console.warn('Failed to save .prr/lessons.md:', error);
    }

    // 2. Sync COMPACTED lessons to other files (CLAUDE.md, etc.)
    const compactedMarkdown = this.toCompactedMarkdown();
    const prrSection = `${PRR_SECTION_START}\n${compactedMarkdown}\n${PRR_SECTION_END}`;

    const syncedTo: string[] = [];

    for (const target of this.syncTargets) {
      const config = SYNC_TARGETS[target];
      const filePath = config.path(this.workdir);

      try {
        // Ensure directory exists
        const dir = dirname(filePath);
        if (!existsSync(dir)) {
          await mkdir(dir, { recursive: true });
        }

        let finalContent: string;

        if (existsSync(filePath)) {
          // Read existing file and update only our section
          const existingContent = await readFile(filePath, 'utf-8');
          const startIdx = existingContent.indexOf(PRR_SECTION_START);
          const endIdx = existingContent.indexOf(PRR_SECTION_END);

          if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
            // Replace existing prr section
            finalContent =
              existingContent.slice(0, startIdx) +
              prrSection +
              existingContent.slice(endIdx + PRR_SECTION_END.length);
          } else {
            // Append prr section to end
            finalContent = existingContent.trimEnd() + '\n\n' + prrSection + '\n';
          }
        } else {
          // Create new file with header + our section
          finalContent = (config.createHeader || '') + prrSection + '\n';
        }

        await writeFile(filePath, finalContent, 'utf-8');
        syncedTo.push(config.description);
      } catch (error) {
        // Silently skip files that can't be written
      }
    }

    if (syncedTo.length > 0) {
      console.log(`Synced to: ${syncedTo.join(', ')}`);
    }

    if (success) {
      this.repoLessonsDirty = false;
    }
    return success;
  }

  /**
   * Generate compacted markdown for syncing to other files.
   * WHY: CLAUDE.md should stay readable - don't bloat with hundreds of lessons.
   */
  private toCompactedMarkdown(): string {
    const lines: string[] = [
      '## PRR Lessons Learned',
      '',
      '> Auto-synced from `.prr/lessons.md` - edit there for full history.',
      '',
    ];

    // Compact global lessons (most recent N)
    const globalLessons = this.store.global.slice(-MAX_GLOBAL_LESSONS_FOR_SYNC);
    if (globalLessons.length > 0) {
      lines.push('### Global');
      lines.push('');
      for (const lesson of globalLessons) {
        lines.push(`- ${lesson}`);
      }
      if (this.store.global.length > MAX_GLOBAL_LESSONS_FOR_SYNC) {
        lines.push(`- _(${this.store.global.length - MAX_GLOBAL_LESSONS_FOR_SYNC} more in .prr/lessons.md)_`);
      }
      lines.push('');
    }

    // Compact file-specific lessons (top N files, M lessons each)
    const sortedFiles = Object.entries(this.store.files)
      .filter(([, lessons]) => lessons.length > 0)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, MAX_FILES_FOR_SYNC);

    if (sortedFiles.length > 0) {
      lines.push('### By File');
      lines.push('');

      for (const [filePath, lessons] of sortedFiles) {
        const recentLessons = lessons.slice(-MAX_FILE_LESSONS_FOR_SYNC);
        lines.push(`**${filePath}**`);
        for (const lesson of recentLessons) {
          lines.push(`- ${lesson}`);
        }
        if (lessons.length > MAX_FILE_LESSONS_FOR_SYNC) {
          lines.push(`- _(${lessons.length - MAX_FILE_LESSONS_FOR_SYNC} more)_`);
        }
        lines.push('');
      }

      const totalFiles = Object.keys(this.store.files).length;
      if (totalFiles > MAX_FILES_FOR_SYNC) {
        lines.push(`_(${totalFiles - MAX_FILES_FOR_SYNC} more files in .prr/lessons.md)_`);
        lines.push('');
      }
    }

    return lines.join('\n');
  }

  /**
   * Check if there are new lessons to export to repo.
   */
  hasNewLessonsForRepo(): boolean {
    return this.repoLessonsDirty;
  }

  /**
   * Add a lesson. Automatically determines scope based on content.
   * Format: "Fix for path/file.ext:line rejected: reason"
   */
  addLesson(lesson: string): void {
    // Extract file path from lesson
    let filePath: string | null = null;
    if (lesson.startsWith('Fix for ')) {
      const remainder = lesson.slice('Fix for '.length);
      const matches = Array.from(remainder.matchAll(/:(\d+)(?::\d+)?(?=\s|$)/g));
      if (matches.length > 0) {
        const lastMatch = matches[matches.length - 1];
        if (typeof lastMatch.index === 'number') {
          filePath = remainder.slice(0, lastMatch.index);
        }
      }
    }

    if (filePath) {
      this.addFileLesson(filePath, lesson);
    } else {
      this.addGlobalLesson(lesson);
    }
  }

  addGlobalLesson(lesson: string): void {
    // Deduplicate
    if (!this.store.global.includes(lesson)) {
      // Check for similar lesson (same prefix)
      const prefix = lesson.substring(0, 50);
      const existingIndex = this.store.global.findIndex(l => l.startsWith(prefix));

      if (existingIndex !== -1) {
        // Replace with newer (not a new lesson, just an update)
        this.store.global[existingIndex] = lesson;
      } else {
        // Truly new lesson
        this.store.global.push(lesson);
        this.newLessonsThisSession++;
      }
      this.dirty = true;
      this.repoLessonsDirty = true;
    }
  }

  addFileLesson(filePath: string, lesson: string): void {
    if (!this.store.files[filePath]) {
      this.store.files[filePath] = [];
    }

    const lessons = this.store.files[filePath];

    // Deduplicate by file:line key
    const keyMatch = lesson.match(/^Fix for ([^:]+:\S+)/);
    const key = keyMatch ? keyMatch[1] : null;

    if (key) {
      const existingIndex = lessons.findIndex(l => l.startsWith(`Fix for ${key}`));
      if (existingIndex !== -1) {
        // Replace with newer (not a new lesson, just an update)
        lessons[existingIndex] = lesson;
        this.dirty = true;
        this.repoLessonsDirty = true;
        return;
      }
    }

    if (!lessons.includes(lesson)) {
      // Truly new lesson
      lessons.push(lesson);
      this.newLessonsThisSession++;
      this.dirty = true;
      this.repoLessonsDirty = true;
    }
  }

  /**
   * Get lessons relevant to a set of files.
   * Returns global lessons + lessons for each specified file.
   */
  getLessonsForFiles(filePaths: string[]): string[] {
    const result: string[] = [...this.store.global];
    
    for (const filePath of filePaths) {
      const fileLessons = this.store.files[filePath] || [];
      result.push(...fileLessons);
    }
    
    return result;
  }

  /**
   * Get all lessons (for display/debugging)
   */
  getAllLessons(): { global: string[]; files: Record<string, string[]> } {
    return {
      global: [...this.store.global],
      files: Object.fromEntries(
        Object.entries(this.store.files).map(([k, v]) => [k, [...v]])
      ),
    };
  }

  /**
   * Get total lesson count
   */
  getTotalCount(): number {
    return this.store.global.length + 
      Object.values(this.store.files).reduce((sum, arr) => sum + arr.length, 0);
  }

  /**
   * Get count of new lessons added this session.
   * WHY: Helps users understand if progress is being made.
   * "22 lessons" is ambiguous - "22 lessons (5 new)" shows activity.
   */
  getNewLessonsCount(): number {
    return this.newLessonsThisSession;
  }

  /**
   * Get count of lessons that existed before this session started.
   */
  getExistingLessonsCount(): number {
    return this.initialLessonCount;
  }

  /**
   * Get count by scope
   */
  getCounts(): { global: number; fileSpecific: number; files: number; newThisSession: number } {
    const fileSpecific = Object.values(this.store.files).reduce((sum, arr) => sum + arr.length, 0);
    return {
      global: this.store.global.length,
      fileSpecific,
      files: Object.keys(this.store.files).length,
      newThisSession: this.newLessonsThisSession,
    };
  }

  /**
   * Compact lessons - remove old/stale entries
   * Keep only the most recent N lessons per file
   */
  compact(maxPerFile: number = 10, maxGlobal: number = 20): number {
    let removed = 0;
    
    // Compact global
    if (this.store.global.length > maxGlobal) {
      removed += this.store.global.length - maxGlobal;
      this.store.global = this.store.global.slice(-maxGlobal);
      this.dirty = true;
    }
    
    // Compact per-file
    for (const [filePath, lessons] of Object.entries(this.store.files)) {
      if (lessons.length > maxPerFile) {
        removed += lessons.length - maxPerFile;
        this.store.files[filePath] = lessons.slice(-maxPerFile);
        this.dirty = true;
      }
    }
    
    return removed;
  }
}
