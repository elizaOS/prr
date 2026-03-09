/**
 * File utilities: directory tree, source reading with token budget, doc discovery.
 * Respects .gitignore-style patterns (simplified). Skips binary, node_modules, dist, etc.
 */
import { readFileSync, readdirSync, statSync, existsSync, openSync, readSync, closeSync } from 'fs';
import { join, relative } from 'path';

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'build', 'out', '.next', '.nuxt', 'coverage', '.cache']);
const SKIP_EXT = new Set(['.lock', '.lockb', '.min.js', '.min.css']);
const MAX_FILE_BYTES = 100 * 1024; // 100KB
const BINARY_CHECK_BYTES = 8192;

function isBinary(filePath: string): boolean {
  try {
    const fd = openSync(filePath, 'r');
    const buf = Buffer.alloc(BINARY_CHECK_BYTES);
    const bytesRead = readSync(fd, buf, 0, BINARY_CHECK_BYTES, 0);
    closeSync(fd);
    for (let i = 0; i < bytesRead; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function shouldSkipDir(name: string): boolean {
  return SKIP_DIRS.has(name) || name.startsWith('.');
}

function shouldSkipFile(name: string, fullPath: string): boolean {
  for (const ext of SKIP_EXT) {
    if (name.endsWith(ext)) return true;
  }
  try {
    const st = statSync(fullPath);
    if (st.size > MAX_FILE_BYTES) return true;
  } catch {
    return true;
  }
  return false;
}

const SOURCE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.c', '.cpp', '.h', '.hpp',
  '.rb', '.php', '.swift', '.r', '.sql', '.sh', '.bash', '.zsh',
  '.vue', '.svelte', '.astro', '.md', '.mdx', '.json', '.yaml', '.yml',
  '.toml', '.ini', '.cfg', '.conf', '.html', '.css', '.scss', '.less',
]);

function isSourceLike(name: string): boolean {
  const ext = name.includes('.') ? '.' + name.split('.').pop()! : '';
  return SOURCE_EXT.has(ext) || name === 'Dockerfile' || name === 'Makefile';
}

/**
 * Rough token estimate: chars/4. Good enough for budgeting.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Recursively list files, respecting skip rules. Returns relative paths from dir.
 */
function listFiles(dir: string, baseDir: string, out: string[]): void {
  let entries: { name: string; path: string }[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }).map((d) => ({
      name: d.name,
      path: join(dir, d.name),
    }));
  } catch {
    return;
  }
  for (const { name, path: fullPath } of entries) {
    try {
      const st = statSync(fullPath);
      if (st.isDirectory()) {
        if (!shouldSkipDir(name)) listFiles(fullPath, baseDir, out);
        continue;
      }
      if (!st.isFile()) continue;
      if (shouldSkipFile(name, fullPath)) continue;
      if (isBinary(fullPath)) continue;
      out.push(relative(baseDir, fullPath));
    } catch {
      // skip
    }
  }
}

/**
 * Produce an ls-tree style string of the project (files only, no content).
 * Skips node_modules, dist, .git, binaries, files > 100KB, lock files.
 */
export function readDirectoryTree(dir: string): string {
  const files: string[] = [];
  listFiles(dir, dir, files);
  files.sort();
  return files.length ? files.join('\n') : '(empty)';
}

/**
 * Read source-like files up to a token budget. Returns a single string with
 * file headers and content. Prefers files that look like source (by extension).
 */
export function readSourceFiles(dir: string, tokenBudget: number): string {
  const files: string[] = [];
  listFiles(dir, dir, files);
  const sourceFiles = files.filter((f) => isSourceLike(f));
  const parts: string[] = [];
  let tokens = 0;
  for (const rel of sourceFiles) {
    if (tokens >= tokenBudget) break;
    const fullPath = join(dir, rel);
    try {
      const content = readFileSync(fullPath, 'utf-8');
      const t = estimateTokens(content);
      if (tokens + t > tokenBudget && parts.length > 0) break;
      parts.push(`\n--- ${rel} ---\n${content}`);
      tokens += t;
    } catch {
      // skip
    }
  }
  return parts.length ? parts.join('\n') : '';
}

const DOC_FILES = [
  'README.md', 'AGENTS.md', 'CLAUDE.md', 'CONVENTIONS.md', 'llms.txt', 'llms-full.txt',
  'DEVELOPMENT.md', 'CONTRIBUTING.md', 'ARCHITECTURE.md', 'PRODUCT.md',
  'package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod',
];
const DOC_DIRS = ['docs', '.cursor/rules', '.prr'];

/**
 * Discover and read documentation files. Returns concatenated content with headers.
 */
export function readDocFiles(dir: string): string {
  const parts: string[] = [];
  for (const name of DOC_FILES) {
    const full = join(dir, name);
    if (!existsSync(full)) continue;
    try {
      const st = statSync(full);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
      const content = readFileSync(full, 'utf-8');
      if (content.includes('\0')) continue;
      parts.push(`\n--- ${name} ---\n${content}`);
    } catch {
      // skip
    }
  }
  for (const docDir of DOC_DIRS) {
    const fullDir = join(dir, docDir);
    if (!existsSync(fullDir)) continue;
    try {
      const entries = readdirSync(fullDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.md') && !e.name.endsWith('.mdc') && !e.name.endsWith('.txt')) continue;
        const full = join(fullDir, e.name);
        const rel = join(docDir, e.name);
        try {
          const st = statSync(full);
          if (st.size > MAX_FILE_BYTES) continue;
          const content = readFileSync(full, 'utf-8');
          if (content.includes('\0')) continue;
          parts.push(`\n--- ${rel} ---\n${content}`);
        } catch {
          // skip
        }
      }
    } catch {
      // skip
    }
  }
  return parts.length ? parts.join('\n') : '';
}
