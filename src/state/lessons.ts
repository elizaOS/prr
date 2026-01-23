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

function getLessonsPath(owner: string, repo: string, branch: string): string {
  // Sanitize branch name for filesystem
  const safeBranch = branch.replace(/[/\\:*?"<>|]/g, '_');
  return join(homedir(), '.prr', 'lessons', owner, repo, `${safeBranch}.json`);
}

export class LessonsManager {
  private store: LessonsStore;
  private storePath: string;
  private dirty = false;

  constructor(owner: string, repo: string, branch: string) {
    this.storePath = getLessonsPath(owner, repo, branch);
    this.store = {
      owner,
      repo,
      branch,
      lastUpdated: new Date().toISOString(),
      global: [],
      files: {},
    };
  }

  async load(): Promise<void> {
    if (existsSync(this.storePath)) {
      try {
        const content = await readFile(this.storePath, 'utf-8');
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
          
          const globalCount = this.store.global.length;
          const fileCount = Object.keys(this.store.files).length;
          const fileLessonCount = Object.values(this.store.files).reduce((sum, arr) => sum + arr.length, 0);
          
          if (globalCount > 0 || fileLessonCount > 0) {
            console.log(`Loaded lessons: ${globalCount} global, ${fileLessonCount} file-specific (${fileCount} files)`);
          }
        }
      } catch (error) {
        console.warn('Failed to load lessons file, starting fresh:', error);
      }
    }
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
    if (!this.dirty) return;
    
    this.store.lastUpdated = new Date().toISOString();
    
    // Ensure directory exists
    const dir = dirname(this.storePath);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    
    await writeFile(this.storePath, JSON.stringify(this.store, null, 2), 'utf-8');
    this.dirty = false;
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
        return;
      }
    }
    
    if (!lessons.includes(lesson)) {
      lessons.push(lesson);
      this.dirty = true;
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
