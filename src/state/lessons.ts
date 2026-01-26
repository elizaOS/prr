import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { homedir } from 'os';

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
 * Get path to shared lessons file in repo.
 * WHY: This file can be committed and shared across machines/users.
 *
 * Location follows conventions from other AI tools:
 * - Cursor: .cursor/rules/
 * - Claude Code: CLAUDE.md or .claude/
 * - Aider: CONVENTIONS.md
 *
 * We use .prr/lessons.md which is:
 * 1. Tool-specific (won't conflict with other tools)
 * 2. Human-readable markdown
 * 3. In a hidden directory (like .cursor, .claude)
 * 4. Can be .gitignored if user prefers not to share
 */
function getRepoLessonsPath(workdir: string): string {
  return join(workdir, '.prr', 'lessons.md');
}

export class LessonsManager {
  private store: LessonsStore;
  private localStorePath: string;
  private repoStorePath: string | null = null;
  private workdir: string | null = null;
  private dirty = false;
  private repoLessonsDirty = false;

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
    this.repoStorePath = getRepoLessonsPath(workdir);
  }

  async load(): Promise<void> {
    // Load local (machine-specific) lessons
    await this.loadLocalLessons();

    // Load and merge repo (shared) lessons
    if (this.repoStorePath) {
      await this.loadRepoLessons();
    }

    // Report loaded lessons
    const globalCount = this.store.global.length;
    const fileCount = Object.keys(this.store.files).length;
    const fileLessonCount = Object.values(this.store.files).reduce((sum, arr) => sum + arr.length, 0);

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
   * Load lessons from repo's .prr/lessons.md file and merge with local lessons.
   * WHY: Team members can share lessons across machines.
   */
  private async loadRepoLessons(): Promise<void> {
    if (!this.repoStorePath || !existsSync(this.repoStorePath)) {
      return;
    }

    try {
      const content = await readFile(this.repoStorePath, 'utf-8');
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
      for (const [filePath, lessons] of Object.entries(repoLessons.files)) {
        if (!this.store.files[filePath]) {
          this.store.files[filePath] = [];
        }
        for (const lesson of lessons) {
          if (!this.store.files[filePath].includes(lesson)) {
            this.store.files[filePath].push(lesson);
            merged++;
          }
        }
      }

      if (merged > 0) {
        console.log(`Merged ${merged} lessons from repo .prr/lessons.md`);
      }
    } catch (error) {
      console.warn('Failed to load repo lessons file:', error);
    }
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
      /failed: 4\d{2}/i,                     // 4xx client errors (except useful ones)
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
   * Save lessons to the repo's .prr/lessons.md file for sharing.
   * WHY: Team coordination - multiple developers can learn from each other's experiences.
   *
   * Call this explicitly when you want to export lessons to the repo.
   * The file can then be committed and pushed to share with the team.
   */
  async saveToRepo(): Promise<boolean> {
    if (!this.repoStorePath || !this.workdir) {
      console.warn('Cannot save to repo: workdir not set');
      return false;
    }

    try {
      // Ensure .prr directory exists in repo
      const dir = dirname(this.repoStorePath);
      if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
      }

      const markdown = this.toMarkdown();
      await writeFile(this.repoStorePath, markdown, 'utf-8');

      console.log(`Saved lessons to repo: ${this.repoStorePath}`);
      this.repoLessonsDirty = false;
      return true;
    } catch (error) {
      console.warn('Failed to save lessons to repo:', error);
      return false;
    }
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
    const fileMatch = lesson.match(/^Fix for ([^:]+):/);
    
    if (fileMatch) {
      const filePath = fileMatch[1];
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
        // Replace with newer
        this.store.global[existingIndex] = lesson;
      } else {
        this.store.global.push(lesson);
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
        lessons[existingIndex] = lesson;
        this.dirty = true;
        this.repoLessonsDirty = true;
        return;
      }
    }

    if (!lessons.includes(lesson)) {
      lessons.push(lesson);
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
   * Get count by scope
   */
  getCounts(): { global: number; fileSpecific: number; files: number } {
    const fileSpecific = Object.values(this.store.files).reduce((sum, arr) => sum + arr.length, 0);
    return {
      global: this.store.global.length,
      fileSpecific,
      files: Object.keys(this.store.files).length,
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
