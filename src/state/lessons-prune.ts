/**
 * Lessons pruning and tidying functions
 */
import { existsSync } from 'fs';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { readdirSync, statSync } from 'fs';
import chalk from 'chalk';
import type { LessonsContext, LessonsStore } from './lessons-context.js';
import * as Normalize from './lessons-normalize.js';
import * as Parse from './lessons-parse.js';

const TRANSIENT_PATTERNS = [
  /connection refused/i,
  /ECONNREFUSED/i,
  /timed out/i,
  /timeout/i,
  /ETIMEDOUT/i,
  /network error/i,
  /socket hang up/i,
  /ENOTFOUND/i,
  /getaddrinfo\s+(?:EAI_AGAIN|ENOTFOUND|EAI_NONAME)/i,
  /certificate\s+(?:error|expired|invalid|revoked)/i,
  /(?:SSL|TLS)\s+(?:error|handshake|certificate|version)/i,
  /rate limit/i,
  /429 Too Many Requests/i,
  /503 Service Unavailable/i,
  /502 Bad Gateway/i,
  /authentication failed/i,
  /invalid API key/i,
  /unauthorized/i,
  /permission denied/i,
  /EACCES/i,
  /spawn .* ENOENT/i,
  /command not found/i,
];

export function pruneTransientLessons(ctx: LessonsContext): number {
  let removed = 0;
  
  const isTransient = (lesson: string): boolean => {
    return TRANSIENT_PATTERNS.some(pattern => pattern.test(lesson));
  };
  
  ctx.store.global = ctx.store.global.filter(l => {
    if (isTransient(l)) {
      removed++;
      return false;
    }
    return true;
  });
  
  for (const filePath in ctx.store.files) {
    const before = ctx.store.files[filePath].length;
    ctx.store.files[filePath] = ctx.store.files[filePath].filter(l => !isTransient(l));
    removed += before - ctx.store.files[filePath].length;
    
    if (ctx.store.files[filePath].length === 0) {
      delete ctx.store.files[filePath];
    }
  }
  
  return removed;
}

export function sanitizeModelNames(ctx: LessonsContext): number {
  let sanitized = 0;
  
  const stripModelNames = (lesson: string): string => {
    // Match common model name patterns (claude, gpt, o1/o3, gemini, deepseek, etc.)
    return lesson.replace(/\b(?:claude-(?:sonnet|opus|haiku|code)?-?[0-9a-z.-]*|gpt-?[0-9a-z.-]+|o[1-9]-?[^\s]*|gemini-[^\s]+|deepseek-[^\s]+|codex-?[^\s]*)\b/gi, '');
  };
  
  ctx.store.global = ctx.store.global.map(l => {
    const cleaned = stripModelNames(l);
    if (cleaned !== l) sanitized++;
    return cleaned;
  });
  
  for (const filePath in ctx.store.files) {
    ctx.store.files[filePath] = ctx.store.files[filePath].map(l => {
      const cleaned = stripModelNames(l);
      if (cleaned !== l) sanitized++;
      return cleaned;
    });
  }
  
  return sanitized;
}

export function pruneRelativeLessons(ctx: LessonsContext): number {
  let removed = 0;
  
  const hasRelativeRef = (lesson: string): boolean => {
    return /\b(?:Issue|Task|Bug|Fix)\s+\d+\b/i.test(lesson) ||
           /\bthe\s+(?:above|below|previous|next)\s+/i.test(lesson);
  };
  
  ctx.store.global = ctx.store.global.filter(l => {
    if (hasRelativeRef(l)) {
      removed++;
      return false;
    }
    return true;
  });
  
  for (const filePath in ctx.store.files) {
    const before = ctx.store.files[filePath].length;
    ctx.store.files[filePath] = ctx.store.files[filePath].filter(l => !hasRelativeRef(l));
    removed += before - ctx.store.files[filePath].length;
    
    if (ctx.store.files[filePath].length === 0) {
      delete ctx.store.files[filePath];
    }
  }
  
  return removed;
}

export function pruneDeletedFiles(ctx: LessonsContext, workdir: string): number {
  if (!workdir) return 0;
  
  let removed = 0;
  
  for (const filePath in ctx.store.files) {
    const cleanedPath = Normalize.sanitizeFilePathHeader(filePath);
    const pathWithoutLine = cleanedPath.replace(/:\d+$/, '');
    const fullPath = join(workdir, pathWithoutLine);
    
    if (!existsSync(fullPath)) {
      const count = ctx.store.files[filePath].length;
      delete ctx.store.files[filePath];
      removed += count;
    }
  }
  
  if (removed > 0) {
    ctx.dirty = true;
    ctx.repoLessonsDirty = true;
  }
  
  return removed;
}

/**
 * Tidy a lessons store in-place: re-normalize, deduplicate, prune garbage.
 * 
 * WHY: Over time lessons accumulate garbage from parsing failures, infra errors,
 * and non-actionable entries. This runs every filter we have to clean them up.
 * 
 * Returns stats about what was removed.
 */
function tidyStore(store: LessonsStore): {
  originalGlobal: number;
  originalFileTotal: number;
  removedNormalize: number;
  removedDuplicate: number;
  removedTransient: number;
  removedRelative: number;
  finalGlobal: number;
  finalFileTotal: number;
} {
  const originalGlobal = store.global.length;
  const originalFileTotal = Object.values(store.files).reduce((sum, arr) => sum + arr.length, 0);
  let removedNormalize = 0;
  let removedDuplicate = 0;
  let removedTransient = 0;
  let removedRelative = 0;

  // Step 1: Re-normalize all lessons (applies latest filters)
  const normalizeAndDedupe = (lessons: string[]): string[] => {
    const seenExact = new Set<string>();
    const seenNear = new Set<string>();
    const result: string[] = [];
    
    for (const lesson of lessons) {
      const normalized = Normalize.normalizeLessonText(lesson);
      if (!normalized) {
        removedNormalize++;
        continue;
      }
      const key = Normalize.lessonKey(normalized);
      if (seenExact.has(key)) {
        removedDuplicate++;
        continue;
      }
      // Also check near-key for fuzzy dedup (using separate Set)
      const nearKey = Normalize.lessonNearKey(normalized);
      if (seenNear.has(nearKey)) {
        removedDuplicate++;
        continue;
      }
      seenExact.add(key);
      seenNear.add(nearKey);
      result.push(normalized);
    }
    return result;
  };

  store.global = normalizeAndDedupe(store.global);

  for (const filePath of Object.keys(store.files)) {
    // Clean up the file path header too
    const cleanedPath = Normalize.sanitizeFilePathHeader(filePath);
    const lessons = normalizeAndDedupe(store.files[filePath]);
    
    delete store.files[filePath];
    if (lessons.length > 0) {
      if (cleanedPath && cleanedPath !== filePath) {
        // Merge into cleaned path if it already exists
        if (store.files[cleanedPath]) {
          const existing = new Set(store.files[cleanedPath].map(l => Normalize.lessonKey(l)));
          for (const l of lessons) {
            if (!existing.has(Normalize.lessonKey(l))) {
              store.files[cleanedPath].push(l);
            } else {
              removedDuplicate++;
            }
          }
        } else {
          store.files[cleanedPath] = lessons;
        }
      } else {
        store.files[cleanedPath || filePath] = lessons;
      }
    }
  }

  // Step 2: Prune transient/infra lessons
  const isTransient = (lesson: string): boolean => {
    return TRANSIENT_PATTERNS.some(pattern => pattern.test(lesson));
  };

  const beforeTransientGlobal = store.global.length;
  store.global = store.global.filter(l => !isTransient(l));
  removedTransient += beforeTransientGlobal - store.global.length;

  for (const filePath of Object.keys(store.files)) {
    const before = store.files[filePath].length;
    store.files[filePath] = store.files[filePath].filter(l => !isTransient(l));
    removedTransient += before - store.files[filePath].length;
    if (store.files[filePath].length === 0) delete store.files[filePath];
  }

  // Step 3: Prune relative references
  const hasRelativeRef = (lesson: string): boolean => {
    return /\b(?:Issue|Task|Bug|Fix)\s+\d+\b/i.test(lesson) ||
           /\bthe\s+(?:above|below|previous|next)\s+/i.test(lesson);
  };

  const beforeRelativeGlobal = store.global.length;
  store.global = store.global.filter(l => !hasRelativeRef(l));
  removedRelative += beforeRelativeGlobal - store.global.length;

  for (const filePath of Object.keys(store.files)) {
    const before = store.files[filePath].length;
    store.files[filePath] = store.files[filePath].filter(l => !hasRelativeRef(l));
    removedRelative += before - store.files[filePath].length;
    if (store.files[filePath].length === 0) delete store.files[filePath];
  }

  const finalGlobal = store.global.length;
  const finalFileTotal = Object.values(store.files).reduce((sum, arr) => sum + arr.length, 0);

  return {
    originalGlobal,
    originalFileTotal,
    removedNormalize,
    removedDuplicate,
    removedTransient,
    removedRelative,
    finalGlobal,
    finalFileTotal,
  };
}

/**
 * Tidy all lessons files on disk.
 * 
 * Scans ~/.prr/lessons/ for all stored lesson files, loads each one,
 * runs the full tidy pipeline, and saves back.
 */
export async function tidyAllLessons(): Promise<void> {
  const lessonsDir = join(homedir(), '.prr', 'lessons');
  
  if (!existsSync(lessonsDir)) {
    console.log(chalk.yellow('No lessons directory found (~/.prr/lessons/)'));
    return;
  }

  // Find all .json lesson files recursively
  const jsonFiles: string[] = [];
  function scanDir(dir: string): void {
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        try {
          const stat = statSync(fullPath);
          if (stat.isDirectory()) {
            scanDir(fullPath);
          } else if (entry.endsWith('.json')) {
            jsonFiles.push(fullPath);
          }
        } catch { /* skip unreadable entries */ }
      }
    } catch { /* skip unreadable dirs */ }
  }
  scanDir(lessonsDir);

  if (jsonFiles.length === 0) {
    console.log(chalk.yellow('No lesson files found'));
    return;
  }

  console.log(chalk.cyan(`\nFound ${jsonFiles.length} lesson file(s)\n`));

  let totalOriginal = 0;
  let totalFinal = 0;
  let totalRemoved = 0;
  let filesModified = 0;

  for (const filePath of jsonFiles) {
    const relativePath = filePath.replace(lessonsDir + '/', '');
    
    try {
      const content = await readFile(filePath, 'utf-8');
      const store = JSON.parse(content) as LessonsStore;
      
      const stats = tidyStore(store);
      const originalTotal = stats.originalGlobal + stats.originalFileTotal;
      const finalTotal = stats.finalGlobal + stats.finalFileTotal;
      const removed = originalTotal - finalTotal;
      
      totalOriginal += originalTotal;
      totalFinal += finalTotal;
      totalRemoved += removed;

      if (removed > 0) {
        // Save back
        store.lastUpdated = new Date().toISOString();
        const dir = dirname(filePath);
        if (!existsSync(dir)) {
          await mkdir(dir, { recursive: true });
        }
        await writeFile(filePath, JSON.stringify(store, null, 2), 'utf-8');
        filesModified++;

        console.log(chalk.green(`  ✓ ${relativePath}: ${originalTotal} → ${finalTotal} lessons (removed ${removed})`));
        if (stats.removedNormalize > 0) console.log(chalk.gray(`      ${stats.removedNormalize} failed normalization (garbage/malformed)`));
        if (stats.removedDuplicate > 0) console.log(chalk.gray(`      ${stats.removedDuplicate} duplicates`));
        if (stats.removedTransient > 0) console.log(chalk.gray(`      ${stats.removedTransient} transient/infra errors`));
        if (stats.removedRelative > 0) console.log(chalk.gray(`      ${stats.removedRelative} relative references`));
      } else {
        console.log(chalk.gray(`  - ${relativePath}: ${originalTotal} lessons (already clean)`));
      }
    } catch (e) {
      console.log(chalk.red(`  ✗ ${relativePath}: ${e}`));
    }
  }

  console.log(chalk.cyan(`\n  Summary: ${totalOriginal} → ${totalFinal} lessons total (removed ${totalRemoved} across ${filesModified} file(s))`));

  // Also tidy any .prr/lessons.md in the current working directory
  const cwd = process.cwd();
  const repoLessonsPath = join(cwd, '.prr', 'lessons.md');
  if (existsSync(repoLessonsPath)) {
    await tidyMarkdownLessonsFile(repoLessonsPath);
  }

  console.log('');
}

/**
 * Flexible markdown parser that handles both lesson file formats:
 * - Format 1: ## Global Lessons / ## File-Specific Lessons / ### filename
 * - Format 2: ### Global / ### By File / **filename**
 */
function parseMarkdownFlexible(content: string): { global: string[]; files: Record<string, string[]> } {
  const result: { global: string[]; files: Record<string, string[]> } = { global: [], files: {} };
  const lines = content.split('\n');
  let section: 'none' | 'global' | 'files' = 'none';
  let currentFile: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect global sections
    if (/^#{2,3}\s+Global/i.test(trimmed)) {
      section = 'global';
      currentFile = null;
      continue;
    }

    // Detect file-specific section headers
    if (/^#{2,3}\s+(?:File-Specific|By File)/i.test(trimmed)) {
      section = 'files';
      currentFile = null;
      continue;
    }

    // Detect file headers: ### filename or **filename**
    if (section === 'files' || section === 'none') {
      const h3Match = trimmed.match(/^###\s+(.+)/);
      if (h3Match) {
        currentFile = h3Match[1].trim();
        section = 'files';
        if (!result.files[currentFile]) result.files[currentFile] = [];
        continue;
      }
      const boldMatch = trimmed.match(/^\*\*(.+?)\*\*$/);
      if (boldMatch) {
        currentFile = boldMatch[1].trim();
        section = 'files';
        if (!result.files[currentFile]) result.files[currentFile] = [];
        continue;
      }
    }

    // Also treat any ## that looks like a file path as a file header
    if (/^##\s+\S+\.\w+/.test(trimmed)) {
      currentFile = trimmed.replace(/^##\s+/, '').trim();
      section = 'files';
      if (!result.files[currentFile]) result.files[currentFile] = [];
      continue;
    }

    // Parse lesson lines
    if (trimmed.startsWith('- ')) {
      const lesson = trimmed.substring(2).trim();
      if (!lesson) continue;
      
      if (section === 'global') {
        result.global.push(lesson);
      } else if (section === 'files' && currentFile) {
        result.files[currentFile].push(lesson);
      } else {
        // Default to global if no section detected yet
        result.global.push(lesson);
      }
    }
  }

  return result;
}

/**
 * Tidy a .prr/lessons.md markdown file in place.
 * 
 * Parses the markdown, runs all lessons through normalization/dedup,
 * and rewrites with only clean entries.
 */
async function tidyMarkdownLessonsFile(filePath: string): Promise<void> {
  try {
    const content = await readFile(filePath, 'utf-8');
    
    // Parse the markdown ourselves to handle both formats:
    // Format 1 (lessons-format.ts): ## Global Lessons / ## File-Specific Lessons / ### filename
    // Format 2 (lessons-parse.ts):  ### Global / ### By File / **filename**
    const parsed = parseMarkdownFlexible(content);
    
    const originalGlobal = parsed.global.length;
    const originalFileTotal = Object.values(parsed.files).reduce((sum, arr) => sum + arr.length, 0);
    const originalTotal = originalGlobal + originalFileTotal;

    // Normalize and deduplicate
    const normalizeAndDedupe = (lessons: string[]): string[] => {
      const seenExact = new Set<string>();
      const seenNear = new Set<string>();
      const result: string[] = [];
      for (const lesson of lessons) {
        const normalized = Normalize.normalizeLessonText(lesson);
        if (!normalized) continue;
        const key = Normalize.lessonKey(normalized);
        if (seenExact.has(key)) continue;
        const nearKey = Normalize.lessonNearKey(normalized);
        if (seenNear.has(nearKey)) continue;
        seenExact.add(key);
        seenNear.add(nearKey);
        result.push(normalized);
      }
      return result;
    };

    const cleanGlobal = normalizeAndDedupe(parsed.global);
    const cleanFiles: Record<string, string[]> = {};
    for (const [path, lessons] of Object.entries(parsed.files)) {
      const cleanedPath = Normalize.sanitizeFilePathHeader(path);
      const cleaned = normalizeAndDedupe(lessons);
      if (cleaned.length > 0) {
        cleanFiles[cleanedPath || path] = cleaned;
      }
    }

    const finalTotal = cleanGlobal.length + Object.values(cleanFiles).reduce((sum, arr) => sum + arr.length, 0);
    const removed = originalTotal - finalTotal;

    if (removed === 0) {
      console.log(chalk.gray(`\n  .prr/lessons.md: ${originalTotal} lessons (already clean)`));
      return;
    }

    // Rebuild markdown
    const lines: string[] = [
      '# PRR Lessons Learned',
      '',
      '> This file is auto-generated by [prr](https://github.com/elizaOS/prr).',
      '> It contains lessons learned from PR review fixes to help improve future fix attempts.',
      '> You can edit this file manually or let prr update it.',
      '> To share lessons across your team, commit this file to your repo.',
      '',
    ];

    if (cleanGlobal.length > 0) {
      lines.push('## Global Lessons', '');
      for (const lesson of cleanGlobal) {
        lines.push(`- ${lesson}`);
      }
      lines.push('');
    }

    const sortedFiles = Object.entries(cleanFiles).sort(([a], [b]) => a.localeCompare(b));
    for (const [path, lessons] of sortedFiles) {
      lines.push(`## ${path}`, '');
      for (const lesson of lessons) {
        lines.push(`- ${lesson}`);
      }
      lines.push('');
    }

    await writeFile(filePath, lines.join('\n'), 'utf-8');
    console.log(chalk.green(`\n  .prr/lessons.md: ${originalTotal} → ${finalTotal} lessons (removed ${removed})`));
  } catch (e) {
    console.log(chalk.red(`\n  Failed to tidy .prr/lessons.md: ${e}`));
  }
}
