/**
 * Regex-based import/include extraction for blast-radius dependency graph.
 *
 * **WHY whole-file regex (not line-by-line):** Multi-line `import { … } from 'x'` and Go
 * `import ( … )` blocks are the norm; line-only patterns miss most edges (false negatives).
 *
 * **WHY no comment stripping:** False positives (import text in strings/comments) only widen
 * the radius (safe); stripping comments correctly across languages converges on a parser.
 */

import { extname } from 'path';

/** Internal language keys used by resolver + scanner. */
export type DepScanLang =
  | 'ts'
  | 'python'
  | 'go'
  | 'rust'
  | 'c'
  | 'java'
  | 'kotlin'
  | 'ruby'
  | 'php';

const TS_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

/** Map file extension → scanner language, or null if not scanned. */
export function detectDepScanLang(filePath: string): DepScanLang | null {
  const ext = extname(filePath).toLowerCase();
  if (TS_EXT.has(ext)) return 'ts';
  if (ext === '.py' || ext === '.pyi') return 'python';
  if (ext === '.go') return 'go';
  if (ext === '.rs') return 'rust';
  if (['.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx', '.hh'].includes(ext)) return 'c';
  if (ext === '.java') return 'java';
  if (ext === '.kt' || ext === '.kts') return 'kotlin';
  if (ext === '.rb') return 'ruby';
  if (ext === '.php') return 'php';
  return null;
}

// Static + multi-line named/type/side-effect imports; `\s` in class crosses newlines.
const TS_IMPORT_RE =
  /import\s+(?:type\s+)?(?:(?:[\w*{}\s,]+)\s+from\s+)?['"]([^'"]+)['"]/gs;
const TS_DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const TS_REQUIRE_RE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const TS_REEXPORT_RE =
  /export\s+(?:type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+\w+)?)\s+from\s+['"]([^'"]+)['"]/gs;

const GO_IMPORT_BLOCK_RE = /\bimport\s*\(([\s\S]*?)\)/g;
const GO_SPEC_IN_BLOCK_RE = /(?:\w+\s+)?"([^"]+)"/g;
const GO_SINGLE_IMPORT_RE = /\bimport\s+(?:\w+\s+)?"([^"]+)"/g;

const PYTHON_IMPORT_RE = /^\s*import\s+([\w.]+)/gm;
const PYTHON_FROM_RE = /^\s*from\s+(\.{0,3}[\w.]*)\s+import/gm;

const RUST_MOD_RE = /^\s*mod\s+(\w+)\s*;/gm;

const C_INCLUDE_RE = /^\s*#\s*include\s*"([^"]+)"/gm;

const JAVA_IMPORT_RE = /^\s*import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/gm;

const RUBY_REL_RE = /require_relative\s+['"]([^'"]+)['"]/g;
const RUBY_REQ_RE = /require\s+['"]([^'"]+)['"]/g;

const PHP_REQ_RE = /(?:require|include)(?:_once)?\s*\(?\s*['"]([^'"]+)['"]\s*\)?\s*;/gim;

function addMatches(re: RegExp, content: string, out: Set<string>): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const s = m[1]?.trim();
    if (s) out.add(s);
  }
}

function extractGoImports(content: string, out: Set<string>): void {
  GO_SINGLE_IMPORT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GO_SINGLE_IMPORT_RE.exec(content)) !== null) {
    const inner = m[0];
    if (/\bimport\s*\(/.test(inner)) continue;
    out.add(m[1]!);
  }
  GO_IMPORT_BLOCK_RE.lastIndex = 0;
  while ((m = GO_IMPORT_BLOCK_RE.exec(content)) !== null) {
    const blockBody = m[1] ?? '';
    GO_SPEC_IN_BLOCK_RE.lastIndex = 0;
    let s: RegExpExecArray | null;
    while ((s = GO_SPEC_IN_BLOCK_RE.exec(blockBody)) !== null) {
      out.add(s[1]!);
    }
  }
}

/**
 * Return raw specifier strings (npm-style, paths, package ids, etc.) for dependency resolution.
 */
export function extractImports(filePath: string, content: string): string[] {
  const lang = detectDepScanLang(filePath);
  if (!lang) return [];

  const out = new Set<string>();

  switch (lang) {
    case 'ts':
      addMatches(TS_IMPORT_RE, content, out);
      addMatches(TS_DYNAMIC_IMPORT_RE, content, out);
      addMatches(TS_REQUIRE_RE, content, out);
      addMatches(TS_REEXPORT_RE, content, out);
      break;
    case 'go':
      extractGoImports(content, out);
      break;
    case 'python':
      addMatches(PYTHON_IMPORT_RE, content, out);
      addMatches(PYTHON_FROM_RE, content, out);
      break;
    case 'rust':
      addMatches(RUST_MOD_RE, content, out);
      break;
    case 'c':
      addMatches(C_INCLUDE_RE, content, out);
      break;
    case 'java':
    case 'kotlin':
      addMatches(JAVA_IMPORT_RE, content, out);
      break;
    case 'ruby':
      addMatches(RUBY_REL_RE, content, out);
      addMatches(RUBY_REQ_RE, content, out);
      break;
    case 'php':
      addMatches(PHP_REQ_RE, content, out);
      break;
    default:
      break;
  }

  return [...out];
}
