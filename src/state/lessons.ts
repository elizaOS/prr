import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';
import * as Normalize from './lessons-normalize.js';

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

/**
 * Sanitize lesson text by removing code fragments and noise.
 * Returns null if sanitization results in an empty or non-actionable string.
 */
export function sanitizeLessonText(lesson: string): string | null {
  let result = lesson;
  
  // Remove code blocks
  result = result.replace(/```[\s\S]*?```/g, '');
  
  // Remove inline code
  result = result.replace(/`[^`]+`/g, '');
  
  // Remove URLs
  result = result.replace(/https?:\/\/\S+/g, '');
  
  // Remove file paths that look like code references
  result = result.replace(/\b[\w./\\-]+\.(ts|js|tsx|jsx|json|md|yaml|yml)\b/g, '');
  
  // Remove "(inferred) ts" and similar parsing artifacts (including trailing)
  result = result.replace(/\s*-?\s*\(inferred\)\s*\w*\s*/gi, ' ');
  
  // Normalize "made no changes" malformed variants
  result = result.replace(/made no changes\s*(?=trying)/gi, 'made no changes - ');
  result = result.replace(/made no changes\s*(?=already)/gi, 'made no changes - ');
  result = result.replace(/made no changes\s+already/gi, 'made no changes - already');
  
  // Collapse double hyphens into single separator
  result = result.replace(/\s*-\s*-\s*/g, ' - ');
  
  // Collapse multiple spaces/newlines into single space
  result = result.replace(/\s+/g, ' ');
  
  // Trim trailing separators
  result = result.replace(/\s*:\s*$/, '');
  result = result.replace(/\s*-\s*$/, '');
  
  const trimmed = result.trim();
  if (!trimmed) return null;
  if (/^\s*[\d.]+\s*$/.test(trimmed)) return null;
  if (/\bchars\s+truncated\b/i.test(trimmed)) return null;
  if (/^Fix for\s+\S+(?::(?:null|undefined|\d+))?$/i.test(trimmed)) return null;
  return trimmed;
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
// Note: LessonsSyncTarget is also defined in lessons-context.ts for modular imports.
// This duplicate is kept for backward compatibility with direct imports from lessons.ts.
export type LessonsSyncTarget = 'claude-md' | 'agents-md' | 'conventions-md' | 'cursor-rules';

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
  'agents-md': {
    path: (workdir) => join(workdir, 'AGENTS.md'),
    description: 'AGENTS.md',
    tools: ['OpenAI Codex'],
    createHeader: '# Agent Instructions\n\n',
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
import { MAX_GLOBAL_LESSONS_FOR_SYNC, MAX_FILE_LESSONS_FOR_SYNC, MAX_FILES_FOR_SYNC } from './lessons-paths.js';

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

    // AGENTS.md — used by OpenAI Codex CLI
    if (existsSync(join(this.workdir, 'AGENTS.md'))) {
      detected.push('agents-md');
    }

    // Check for Aider's CONVENTIONS.md or config
    if (existsSync(join(this.workdir, 'CONVENTIONS.md')) ||
        existsSync(join(this.workdir, '.aider.conf.yml'))) {
      detected.push('conventions-md');
    }

    // Check for Cursor native rules directory
    const cursorRulesDir = join(this.workdir, '.cursor', 'rules');
    const cursorRulesFile = join(cursorRulesDir, 'prr-lessons.mdc');
    const cursorRulesDirExists = existsSync(cursorRulesDir);
    const cursorRulesFileExists = existsSync(cursorRulesFile);
    if (cursorRulesDirExists || cursorRulesFileExists) {
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
          const pruned = this.pruneTransientLessons();
          if (pruned > 0) {
            console.log(`Pruned ${pruned} stale/transient lessons`);
            this.dirty = true;
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
      const globalSeen = new Set(this.store.global.map(l => Normalize.lessonKey(l)));
      const globalNearSeen = new Set(this.store.global.map(l => Normalize.lessonNearKey(l)));
      for (const rawLesson of repoLessons.global) {
        const normalized = Normalize.normalizeLessonText(rawLesson);
        if (!normalized) continue;
        const key = Normalize.lessonKey(normalized);
        const nearKey = Normalize.lessonNearKey(normalized);
        if (globalSeen.has(key) || globalNearSeen.has(nearKey)) continue;
        globalSeen.add(key);
        globalNearSeen.add(nearKey);
        this.store.global.push(normalized);
        merged++;
      }
      
      // Merge file-specific lessons
      for (const [rawPath, lessons] of Object.entries(repoLessons.files)) {
        const cleanedPath = Normalize.sanitizeFilePathHeader(rawPath);
        if (!cleanedPath) continue;
        if (!this.store.files[cleanedPath]) {
          this.store.files[cleanedPath] = [];
        }
        const fileSeen = new Set(this.store.files[cleanedPath].map(l => Normalize.lessonKey(l)));
        const fileNearSeen = new Set(this.store.files[cleanedPath].map(l => Normalize.lessonNearKey(l)));
        for (const rawLesson of lessons) {
          const normalized = Normalize.normalizeLessonText(rawLesson);
          if (!normalized) continue;
          const key = Normalize.lessonKey(normalized);
          const nearKey = Normalize.lessonNearKey(normalized);
          if (fileSeen.has(key) || fileNearSeen.has(nearKey)) continue;
          fileSeen.add(key);
          fileNearSeen.add(nearKey);
          this.store.files[cleanedPath].push(normalized);
          merged++;
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
        const rawFile = trimmed.slice(4).trim();
        const cleanedFile = Normalize.sanitizeFilePathHeader(rawFile);
        if (!cleanedFile) {
          currentFile = null;
          continue;
        }
        currentFile = cleanedFile;
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

    const orphanLessons: string[] = [];
    const mergedFiles = new Map<string, { lessons: string[]; seenKeys: Set<string>; seenNear: Set<string>; order: number }>();
    let order = 0;
    
    for (const [rawPath, lessons] of Object.entries(this.store.files)) {
      const cleanedPath = Normalize.sanitizeFilePathHeader(rawPath);
      if (!cleanedPath) continue;
      
      if (!mergedFiles.has(cleanedPath)) {
        mergedFiles.set(cleanedPath, {
          lessons: [],
          seenKeys: new Set(),
          seenNear: new Set(),
          order: order++,
        });
      }
      
      const entry = mergedFiles.get(cleanedPath)!;
      for (const lesson of lessons) {
        const normalized = Normalize.normalizeLessonText(lesson);
        if (!normalized) continue;
        const lessonFilePath = Normalize.extractLessonFilePath(normalized);
        const cleanedLessonPath = lessonFilePath ? Normalize.sanitizeFilePathHeader(lessonFilePath) : null;
        if (!cleanedLessonPath || cleanedLessonPath !== cleanedPath) {
          orphanLessons.push(normalized);
          continue;
        }
        const key = Normalize.lessonKey(normalized);
        const nearKey = Normalize.lessonNearKey(normalized);
        if (entry.seenKeys.has(key) || entry.seenNear.has(nearKey)) continue;
        entry.seenKeys.add(key);
        entry.seenNear.add(nearKey);
        entry.lessons.push(normalized);
      }
    }
    
    // Global lessons
    const globalLessons = Normalize.sanitizeLessonsList([...this.store.global, ...orphanLessons]);
    if (globalLessons.length > 0) {
      lines.push('## Global Lessons');
      lines.push('');
      for (const lesson of globalLessons) {
        lines.push(`- ${lesson}`);
      }
      lines.push('');
    }

    // File-specific lessons
    const fileEntries = Array.from(mergedFiles.entries())
      .map(([filePath, data]) => ({
        filePath,
        lessons: data.lessons,
        order: data.order,
      }))
      .filter(entry => entry.lessons.length > 0)
      .sort((a, b) => a.order - b.order);
    if (fileEntries.length > 0) {
      lines.push('## File-Specific Lessons');
      lines.push('');

      for (const { filePath, lessons } of fileEntries) {
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
        // Log but don't fail - sync targets are best-effort
        console.warn(`Failed to sync lessons to ${config.description}:`, error);
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

    const orphanLessons: string[] = [];
    const mergedFiles = new Map<string, { lessons: string[]; seenKeys: Set<string>; seenNear: Set<string>; order: number }>();
    let order = 0;
    
    for (const [rawPath, lessons] of Object.entries(this.store.files)) {
      const cleanedPath = Normalize.sanitizeFilePathHeader(rawPath);
      if (!cleanedPath) continue;
      
      if (!mergedFiles.has(cleanedPath)) {
        mergedFiles.set(cleanedPath, {
          lessons: [],
          seenKeys: new Set(),
          seenNear: new Set(),
          order: order++,
        });
      }
      
      const entry = mergedFiles.get(cleanedPath)!;
      for (const lesson of lessons) {
        const normalized = Normalize.normalizeLessonText(lesson);
        if (!normalized) continue;
        const lessonFilePath = Normalize.extractLessonFilePath(normalized);
        const cleanedLessonPath = lessonFilePath ? Normalize.sanitizeFilePathHeader(lessonFilePath) : null;
        if (!cleanedLessonPath || cleanedLessonPath !== cleanedPath) {
          orphanLessons.push(normalized);
          continue;
        }
        const key = Normalize.lessonKey(normalized);
        const nearKey = Normalize.lessonNearKey(normalized);
        if (entry.seenKeys.has(key) || entry.seenNear.has(nearKey)) continue;
        entry.seenKeys.add(key);
        entry.seenNear.add(nearKey);
        entry.lessons.push(normalized);
      }
    }
    
    // Compact global lessons (most recent N)
    const globalLessons = Normalize.sanitizeLessonsList([...this.store.global, ...orphanLessons]);
    if (globalLessons.length > 0) {
      const topGlobal = globalLessons.slice(-MAX_GLOBAL_LESSONS_FOR_SYNC);
      lines.push('### Global');
      lines.push('');
      for (const lesson of topGlobal) {
        lines.push(`- ${lesson}`);
      }
      if (globalLessons.length > MAX_GLOBAL_LESSONS_FOR_SYNC) {
        lines.push(`- _(${globalLessons.length - MAX_GLOBAL_LESSONS_FOR_SYNC} more in .prr/lessons.md)_`);
      }
      lines.push('');
    }

    // Compact file-specific lessons (top N files, M lessons each)
    const sortedFiles = Array.from(mergedFiles.entries())
      .map(([filePath, data]) => ({
        filePath,
        lessons: data.lessons,
        order: data.order,
      }))
      .filter(entry => entry.lessons.length > 0)
      .sort((a, b) => a.order - b.order)
      .slice(0, MAX_FILES_FOR_SYNC);

    if (sortedFiles.length > 0) {
      lines.push('### By File');
      lines.push('');

      for (const { filePath, lessons } of sortedFiles) {
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

      const totalFiles = mergedFiles.size;
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
    const filePath = Normalize.extractLessonFilePath(lesson);
    const cleanedPath = filePath ? Normalize.sanitizeFilePathHeader(filePath) : null;

    if (cleanedPath) {
      this.addFileLesson(cleanedPath, lesson);
    } else {
      this.addGlobalLesson(lesson);
    }
  }

  addGlobalLesson(lesson: string): void {
    const normalized = Normalize.normalizeLessonText(lesson);
    if (!normalized) return;
    
    const key = Normalize.lessonKey(normalized);
    const nearKey = Normalize.lessonNearKey(normalized);
    const existingKeys = this.store.global.map(l => Normalize.lessonKey(l));
    const existingNearKeys = this.store.global.map(l => Normalize.lessonNearKey(l));
    
    if (existingKeys.includes(key) || existingNearKeys.includes(nearKey)) return;

    // Jaccard similarity — catches semantic duplicates that key/nearKey miss
    if (this.isSemanticallyDuplicate(normalized, this.store.global)) return;

    this.store.global.push(normalized);
    this.newLessonsThisSession++;
    this.dirty = true;
    this.repoLessonsDirty = true;
  }

  addFileLesson(filePath: string, lesson: string): void {
    const normalized = Normalize.normalizeLessonText(lesson);
    if (!normalized) return;
    
    const cleanedPath = Normalize.sanitizeFilePathHeader(filePath);
    if (!cleanedPath) return;
    
    if (!this.store.files[cleanedPath]) {
      this.store.files[cleanedPath] = [];
    }
    
    const lessons = this.store.files[cleanedPath];
    const key = Normalize.lessonKey(normalized);
    const nearKey = Normalize.lessonNearKey(normalized);
    const existingKeys = lessons.map(l => Normalize.lessonKey(l));
    const existingNearKeys = lessons.map(l => Normalize.lessonNearKey(l));
    
    if (existingKeys.includes(key) || existingNearKeys.includes(nearKey)) return;

    // Jaccard similarity — catches semantic duplicates that key/nearKey miss
    if (this.isSemanticallyDuplicate(normalized, lessons)) return;

    lessons.push(normalized);
    this.newLessonsThisSession++;
    this.dirty = true;
    this.repoLessonsDirty = true;
  }

  private normalizeLessonText(lesson: string): string | null {
    return Normalize.normalizeLessonText(lesson);
  }

  /**
   * Check if a lesson is semantically duplicate of any existing lesson.
   * WHY: key/nearKey dedup catches exact and whitespace-collapsed matches.
   * Jaccard on significant tokens catches "same idea, different wording."
   */
  private isSemanticallyDuplicate(newLesson: string, existingLessons: string[]): boolean {
    const newTokens = Normalize.lessonTokens(newLesson);
    for (const existing of existingLessons) {
      const existingTokens = Normalize.lessonTokens(existing);
      if (Normalize.jaccardSimilarity(newTokens, existingTokens) >= Normalize.LESSON_SIMILARITY_THRESHOLD) {
        return true;
      }
    }
    return false;
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
