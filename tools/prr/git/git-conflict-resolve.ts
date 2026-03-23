/**
 * Git conflict resolution using LLM.
 *
 * WHY LLM for conflicts: Merge conflicts are semantic — "ours" vs "theirs" plus
 * context. Heuristics work for lockfiles and package.json; for source code,
 * an LLM can merge intent and produce a coherent resolution. We validate
 * output (JSON validity, size regression) to catch truncation or corruption.
 */
import chalk from 'chalk';
import { join } from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import type { SimpleGit } from 'simple-git';
import {
  isLockFile,
  getLockFileInfo,
  findFilesWithConflictMarkers,
  hasConflictMarkers,
  hasNestedConflictMarkers,
} from '../../../shared/git/git-clone-index.js';
import type { LLMClient } from '../llm/client.js';
import type { LessonsSyncTarget } from '../state/lessons-context.js';
import type { LessonsContext } from '../state/lessons-context.js';
import * as LessonsAPI from '../state/lessons-index.js';
import type { Runner } from '../../../shared/runners/types.js';
import type { Config } from '../../../shared/config.js';
import { setTokenPhase, debug, formatNumber } from '../../../shared/logger.js';
import {
  MAX_CONFLICT_RESOLUTION_FILE_SIZE,
  CONFLICT_USE_CHUNKED_FIRST_CHARS,
  CONFLICT_USE_CHUNKED_FIRST_CHUNKS,
  CONFLICT_PROMPT_OVERHEAD_CHARS,
  MAX_SINGLE_CHUNK_CHARS,
  MAX_CONFLICT_SYNTAX_FIX_EMBED_CHARS,
  CONFLICT_SYNTAX_FIX_WINDOW_HALF_LINES,
  CONFLICT_SYNTAX_FIX_WINDOW_MAX_CHARS,
  MAX_CONFLICT_SINGLE_SHOT_LLM_CHARS,
  MIN_CONFLICT_RESOLUTION_SIZE_RATIO,
  MIN_LINES_FOR_SIZE_REGRESSION_CHECK,
  DEFAULT_ELIZACLOUD_MODEL,
} from '../../../shared/constants.js';
import {
  buildConflictResolutionPrompt,
  buildConflictResolutionPromptWithContent,
  splitConflictFilesIntoBatches,
} from './git-conflict-prompts.js';
import { handleLockFileConflicts } from './git-conflict-lockfiles.js';
import {
  resolveConflictsChunked,
  resolveConflictsWithTopTailsFallback,
  tryHeuristicResolution,
  extractConflictSides,
  extractConflictChunks,
  getFullFileSides,
  isGeneratedArtifactFile,
  tryResolveGeneratedArtifactSides,
  hasAsymmetricConflict,
  resolveAsymmetricConflict,
  preprocessConflictFileContent,
} from './git-conflict-chunked.js';
import { getMaxFixPromptCharsForModel } from '../../../shared/llm/model-context-limits.js';

/**
 * Documentation and generated documentation files that should use deterministic
 * conflict resolution (keep ours) instead of LLM resolution.
 * 
 * WHY: These files are frequently modified by both sides (PRR adds changelog
 * entries, remote adds entries). LLM resolution of large markdown files:
 *   1. Often exceeds model context (68KB CHANGELOG → 504 timeout on small models)
 *   2. Hallucinates content when it can't see the full file
 *   3. Is expensive and slow for files that can be resolved deterministically
 * 
 * Strategy: keep "ours" side (HEAD in rebase = the local accumulated work).
 * If the remote added important entries, they'll appear in the base after
 * rebase completes — they're not lost, just not duplicated into ours.
 */
const DETERMINISTIC_MERGE_FILES = new Set([
  'CHANGELOG.md',
  'CHANGES.md',
  'HISTORY.md',
  'RELEASES.md',
  'ROADMAP.md',
]);

const DETERMINISTIC_MERGE_PATTERNS = [
  /^docs\//i,
  /^\.github\//i,
  /^CONTRIBUTING/i,
  /^CODE_OF_CONDUCT/i,
  /^SECURITY/i,
  /^AUTHORS/i,
  /^CREDITS/i,
];

/** Paths where we prefer the incoming (theirs) version during base-branch merge. WHY: .github/workflows/ often conflict when base updated the same workflow; taking theirs lets the repo's canonical workflow win so PRR doesn't push a broken or outdated workflow. */
const TAKE_THEIRS_PATTERNS = [
  /^\.github\/workflows\//i,
];

function shouldUseDeterministicMerge(filePath: string): boolean {
  const basename = filePath.split('/').pop() || filePath;
  if (DETERMINISTIC_MERGE_FILES.has(basename)) return true;
  return DETERMINISTIC_MERGE_PATTERNS.some(p => p.test(filePath));
}

function shouldTakeTheirs(filePath: string): boolean {
  return TAKE_THEIRS_PATTERNS.some(p => p.test(filePath));
}

function isExplicitMarkerlessPolicyFile(filePath: string): boolean {
  const basename = filePath.split('/').pop() || filePath;
  return shouldUseDeterministicMerge(filePath)
    || basename.toUpperCase() === 'LICENSE';
}

/**
 * Read one side of a conflicted file from the index (Git stages).
 * WHY stage 1: Proper merge resolution requires the common ancestor (base) so the LLM can merge both
 * changes relative to base; without it we'd do 2-way merge and the model would guess.
 * WHY return '' for stage 1 on error: New-file-in-both has no base; we still want BASE/OURS/THEIRS in
 * the prompt so the format is consistent and the model sees "empty base".
 */
async function readConflictStage(git: SimpleGit, filePath: string, stage: 1 | 2 | 3): Promise<string | null> {
  try {
    const out = await git.raw(['show', `:${stage}:${filePath}`]);
    return out ?? (stage === 1 ? '' : null);
  } catch {
    return stage === 1 ? '' : null;
  }
}

async function resolveMarkerlessConflict(
  git: SimpleGit,
  filePath: string,
  fullPath: string,
  conflictedContent: string
): Promise<{ resolved: boolean; explanation?: string }> {
  const oursText = await readConflictStage(git, filePath, 2);
  const theirsText = await readConflictStage(git, filePath, 3);

  if (isExplicitMarkerlessPolicyFile(filePath)) {
    if (!oursText && !theirsText) {
      return { resolved: false, explanation: 'No stage-2/3 conflict blobs found' };
    }
    const chosen = oursText ?? theirsText!;
    const policy = oursText ? 'kept ours from conflict index' : 'used incoming content (ours missing)';
    const fs = await import('fs');
    fs.writeFileSync(fullPath, chosen, 'utf-8');
    await git.add(filePath);
    return { resolved: true, explanation: `${policy} for markerless deterministic conflict` };
  }

  if (isGeneratedArtifactFile(filePath) && oursText != null && theirsText != null) {
    const generated = tryResolveGeneratedArtifactSides(filePath, oursText, theirsText);
    if (generated?.resolved) {
      const fs = await import('fs');
      fs.writeFileSync(fullPath, generated.content, 'utf-8');
      await git.add(filePath);
      return { resolved: true, explanation: generated.explanation };
    }
  }

  // Markerless but git still unmerged: common after partial tool resolution or driver-specific merges.
  // Prefer OURS (PR branch) unless PRR_MARKERLESS_CONFLICT_PREFER=theirs (incoming/base).
  if (isMarkerlessResolvableSourceFile(filePath) && (oursText != null || theirsText != null)) {
    const preferTheirs = /^theirs$/i.test((process.env.PRR_MARKERLESS_CONFLICT_PREFER ?? '').trim());
    const chosen = preferTheirs ? (theirsText ?? oursText!) : (oursText ?? theirsText!);
    const policy = preferTheirs ? 'theirs (base branch)' : 'ours (PR branch)';
    const fs = await import('fs');
    fs.writeFileSync(fullPath, chosen, 'utf-8');
    await git.add(filePath);
    return {
      resolved: true,
      explanation: `Markerless merge: kept ${policy} from conflict index for ${filePath.split('/').pop()}`,
    };
  }

  // No safe deterministic policy available.
  void conflictedContent;
  return { resolved: false };
}

function isMarkerlessResolvableSourceFile(filePath: string): boolean {
  const ext = filePath.replace(/^.*\./, '').toLowerCase();
  return ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext);
}

/** Stage after runner only if the working tree no longer has conflict markers. WHY: Blind `git add` on all files when the runner reported success can mark conflicts resolved in the index while `<<<<<<<` remains on disk, hiding files from git's unmerged list and confusing later steps. */
async function stageRunnerOutputIfClean(git: SimpleGit, workdir: string, file: string): Promise<void> {
  const fullPath = join(workdir, file);
  if (!existsSync(fullPath)) return;
  try {
    const body = readFileSync(fullPath, 'utf-8');
    if (hasConflictMarkers(body)) {
      console.log(
        chalk.yellow(
          `  Skipping git add (${file}): still has conflict markers — per-file resolution will retry`
        )
      );
      return;
    }
    await git.add(file);
  } catch {
    // File might still be locked or unreadable
  }
}

/**
 * Resolve a conflict by keeping ours (HEAD) side for all conflict regions.
 * Non-conflicted lines are preserved verbatim.
 */
function resolveKeepOurs(content: string): { resolved: boolean; content: string; explanation: string } {
  const lines = content.split('\n');
  const result: string[] = [];
  let inConflict = false;
  let inTheirs = false;

  for (const line of lines) {
    if (line.startsWith('<<<<<<<')) {
      inConflict = true;
      inTheirs = false;
      continue;
    }
    if (line.startsWith('=======') && inConflict) {
      inTheirs = true;
      continue;
    }
    if (line.startsWith('>>>>>>>') && inConflict) {
      inConflict = false;
      inTheirs = false;
      continue;
    }
    if (inConflict && inTheirs) continue;
    result.push(line);
  }

  return {
    resolved: true,
    content: result.join('\n'),
    explanation: 'Kept ours (documentation file — deterministic merge)',
  };
}


/**
 * Validate that resolved TS/JS content parses. Reject before write/stage if invalid.
 * WHY: LLMs can truncate or corrupt output; committing invalid syntax would push broken code. We parse
 * with TypeScript's getSyntacticDiagnostics so only syntactically valid resolutions get written/staged.
 * Returns location (line/column) when available so retry prompts can tell the model where to fix.
 */
async function validateResolvedFileContent(
  content: string,
  filePath: string
): Promise<{ valid: boolean; error?: string; location?: string }> {
  const ext = filePath.replace(/^.*\./, '').toLowerCase();
  if (!['ts', 'tsx', 'js', 'jsx'].includes(ext)) {
    return { valid: true };
  }
  try {
    const ts = await import('typescript').then(m => (m as { default?: unknown }).default ?? m) as typeof import('typescript');
    const sf = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
    const host: import('typescript').CompilerHost = {
      getSourceFile: (name: string) => (name === filePath || name.endsWith(filePath) ? sf : undefined),
      getDefaultLibFileName: () => 'lib.d.ts',
      writeFile: () => {},
      getCurrentDirectory: () => '/root',
      getDirectories: () => [],
      fileExists: () => true,
      readFile: () => undefined,
      getCanonicalFileName: (n: string) => n,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => '\n',
    };
    const program = ts.createProgram([filePath], { noLib: true, skipLibCheck: true }, host);
    const diags = program.getSyntacticDiagnostics(sf);
    const err = diags.find(d => d.category === ts.DiagnosticCategory.Error);
    if (err) {
      const msg = typeof err.messageText === 'string' ? err.messageText : (err.messageText as { messageText: string }).messageText;
      const errorText = String(msg);
      let location: string | undefined;
      if (typeof err.start === 'number' && err.start >= 0) {
        const pos = sf.getLineAndCharacterOfPosition(err.start);
        location = `line ${pos.line + 1}${pos.character > 0 ? `, column ${pos.character + 1}` : ''}`;
      }
      return { valid: false, error: errorText, location };
    }
    return { valid: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { valid: false, error: message };
  }
}

/**
 * Build a retry hint that includes location and error-specific guidance so the LLM can fix the right place.
 * WHY: Output.log showed "closing block comment" and "comma" as the main parse failures; location (line/column)
 * and targeted hints (close block comments, fix commas) improve retry success.
 */
function parseLineNumberFromTsLocation(location: string): number | null {
  const m = /line\s+(\d+)/i.exec(location);
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function findFirstConflictMarkerLine1Based(content: string): number | null {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!.trimStart();
    if (t.startsWith('<<<<<<<')) return i + 1;
  }
  return null;
}

/**
 * When the resolved file is too large for full-file syntax fix, ask the LLM to correct only a window
 * around the parse error (or first conflict marker). Splice back and re-validate.
 */
async function tryFixSyntaxWithLlmWindowed(
  llm: LLMClient,
  conflictFile: string,
  content: string,
  parseValidation: { error?: string; location?: string },
  model?: string
): Promise<{ content: string } | null> {
  const lines = content.split('\n');
  if (lines.length === 0) return null;

  let center =
    parseLineNumberFromTsLocation(parseValidation.location ?? '') ?? findFirstConflictMarkerLine1Based(content);
  if (center == null) center = Math.min(lines.length, Math.floor(lines.length / 2));

  let half = CONFLICT_SYNTAX_FIX_WINDOW_HALF_LINES;
  let start = Math.max(0, center - 1 - half);
  let end = Math.min(lines.length, center - 1 + half);
  let windowText = lines.slice(start, end).join('\n');
  while (windowText.length > CONFLICT_SYNTAX_FIX_WINDOW_MAX_CHARS && half > 40) {
    half = Math.floor(half * 0.7);
    start = Math.max(0, center - 1 - half);
    end = Math.min(lines.length, center - 1 + half);
    windowText = lines.slice(start, end).join('\n');
  }
  if (windowText.length > CONFLICT_SYNTAX_FIX_WINDOW_MAX_CHARS) {
    debug('Windowed syntax fix skipped (fragment still too large)', {
      file: conflictFile,
      chars: windowText.length,
    });
    return null;
  }

  const err = parseValidation.error ?? 'parse error';
  const loc = parseValidation.location ?? 'unknown';
  const ext = conflictFile.replace(/^.*\./, '').toLowerCase();
  const lang = ['ts', 'tsx'].includes(ext) ? 'typescript' : ['js', 'jsx'].includes(ext) ? 'javascript' : ext;
  const prompt = `File ${conflictFile} is too large to send in full (${formatNumber(content.length)} chars). Fix ONLY the fragment below (original lines ${formatNumber(start + 1)}–${formatNumber(end)} of ${formatNumber(lines.length)} total).

Error: ${err}
Location: ${loc}

Remove any git conflict markers (<<<<<<<, =======, >>>>>>>) and fix the syntax error. Preserve behavior outside this fragment.

Return exactly:
FRAGMENT:
\`\`\`${lang}
<corrected fragment — only the lines for this range, merged and valid>
\`\`\`

Fragment:
\`\`\`${lang}
${windowText}
\`\`\``;

  try {
    setTokenPhase('conflict-syntax-fix');
    const response = await llm.complete(prompt, undefined, {
      phase: 'conflict-syntax-fix',
      ...(model ? { model } : {}),
    });
    const body = response?.content?.trim() ?? '';
    const codeMatch = body.match(/FRAGMENT:\s*```[^\n]*\n([\s\S]*?)```/i);
    const fragment = codeMatch ? codeMatch[1]!.trim() : '';
    if (!fragment) return null;
    const fragmentLines = fragment.split('\n');
    const merged = [...lines.slice(0, start), ...fragmentLines, ...lines.slice(end)];
    const fixed = merged.join('\n');
    const recheck = await validateResolvedFileContent(fixed, conflictFile);
    if (recheck.valid) {
      debug('Windowed syntax fix succeeded', { file: conflictFile, startLine: start + 1, endLine: end });
      return { content: fixed };
    }
  } catch (e) {
    debug('Windowed syntax fix failed', { file: conflictFile, error: e });
  }
  return null;
}

function buildParseErrorRetryHint(parseValidation: { error?: string; location?: string }): string {
  const err = parseValidation.error ?? 'parse error';
  const loc = parseValidation.location ? ` at ${parseValidation.location}` : '';
  let hint = err;
  if (loc) hint = `At ${parseValidation.location}: ${err}`;
  // Error-specific guidance (output.log: '*/' expected and ',' expected were the two failures)
  if (/\*\/.*expected|unclosed block comment/i.test(err)) {
    hint += ' Fix unclosed block comments: ensure every /* has a matching */ and no conflict markers or stray text broke a comment.';
  } else if (/',' expected|expected ','|comma/i.test(err)) {
    hint += ' Fix commas: check object/array literals for missing commas between elements or illegal trailing commas.';
  }
  return hint;
}

/**
 * One-shot LLM pass to fix a single syntax error in already-resolved content.
 * WHY: Resolution often produces nearly-correct output; throwing it away and asking the user to fix manually
 * wastes the prior LLM cost. A small "fix the syntax" prompt often corrects missing commas or unclosed comments.
 */
async function tryFixSyntaxWithLlm(
  llm: LLMClient,
  conflictFile: string,
  content: string,
  parseValidation: { error?: string; location?: string },
  model?: string
): Promise<{ content: string } | null> {
  if (content.length > MAX_CONFLICT_SYNTAX_FIX_EMBED_CHARS) {
    const windowed = await tryFixSyntaxWithLlmWindowed(llm, conflictFile, content, parseValidation, model);
    if (windowed) {
      console.log(
        chalk.gray(
          `    → Windowed syntax fix applied (fragment around error; file was ${formatNumber(content.length)} chars)`,
        ),
      );
      return windowed;
    }
    debug('Syntax fix pass skipped (file too large for single-shot prompt)', {
      file: conflictFile,
      chars: content.length,
      max: MAX_CONFLICT_SYNTAX_FIX_EMBED_CHARS,
    });
    console.log(
      chalk.gray(
        `    → Syntax fix skipped: file too large (${formatNumber(content.length)} chars > ${formatNumber(MAX_CONFLICT_SYNTAX_FIX_EMBED_CHARS)}) — use manual merge or chunked resolution`,
      ),
    );
    return null;
  }
  const err = parseValidation.error ?? 'parse error';
  const loc = parseValidation.location ?? 'unknown';
  const ext = conflictFile.replace(/^.*\./, '').toLowerCase();
  const lang = ['ts', 'tsx'].includes(ext) ? 'typescript' : ['js', 'jsx'].includes(ext) ? 'javascript' : ext;
  const prompt = `The following ${conflictFile} file has exactly one syntax error.

Error: ${err}
Location: ${loc}

Fix only the syntax (e.g. add a missing comma, close a block comment with */). Do not change logic or add explanations.
Return the complete corrected file in a single code block. Use this format exactly:

RESOLVED: \`\`\`${lang}
<paste the entire corrected file here>
\`\`\`

File content:
\`\`\`${lang}
${content}
\`\`\``;
  try {
    setTokenPhase('conflict-syntax-fix');
    const response = await llm.complete(prompt, undefined, {
      phase: 'conflict-syntax-fix',
      ...(model ? { model } : {}),
    });
    const body = response?.content?.trim() ?? '';
    const codeMatch = body.match(/RESOLVED:\s*```[^\n]*\n([\s\S]*?)```/);
    const fixed = codeMatch ? codeMatch[1].trim() : body.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '').trim();
    if (!fixed || fixed.length < 100) return null;
    const recheck = await validateResolvedFileContent(fixed, conflictFile);
    if (recheck.valid) {
      debug('Syntax fix pass succeeded', { file: conflictFile });
      return { content: fixed };
    }
  } catch (e) {
    debug('Syntax fix pass failed', { file: conflictFile, error: e });
  }
  return null;
}

/**
 * Validate that resolved content is sane before writing to disk.
 * 
 * WHY: LLMs sometimes catastrophically corrupt files during conflict resolution.
 * Real example: a 23K-line Drizzle migration snapshot was reduced to 250 lines
 * with broken JSON, then committed and pushed. These checks catch such failures.
 * 
 * Checks performed:
 * 1. JSON validation for .json files (catches structural corruption)
 * 2. Size regression detection (catches catastrophic truncation)
 */
function validateResolvedContent(
  filePath: string,
  originalConflictedContent: string,
  resolvedContent: string
): { valid: boolean; reason?: string } {
  // JSON validation: if the file is JSON, ensure the resolution is valid JSON
  if (filePath.endsWith('.json')) {
    try {
      JSON.parse(resolvedContent);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { valid: false, reason: `Invalid JSON after resolution: ${message}` };
    }
  }

  // Size regression: compare resolved content to the larger side of conflicts.
  // The resolved file should not be drastically smaller than the larger conflict side.
  const chunks = extractConflictChunks(originalConflictedContent);
  if (chunks.length > 0) {
    // Find the total size of the larger side across all conflicts
    let totalLargerSideLines = 0;
    for (const chunk of chunks) {
      const { ours, theirs } = extractConflictSides(chunk.conflictLines);
      totalLargerSideLines += Math.max(ours.length, theirs.length);
    }

    // Also count non-conflicted lines (these should be preserved verbatim)
    const originalLines = originalConflictedContent.split('\n');
    const conflictLineSet = new Set<number>();
    for (const chunk of chunks) {
      for (let i = chunk.startLine; i <= chunk.endLine; i++) {
        conflictLineSet.add(i);
      }
    }
    const nonConflictedLineCount = originalLines.length - conflictLineSet.size;
    const expectedMinLines = nonConflictedLineCount + Math.floor(totalLargerSideLines * MIN_CONFLICT_RESOLUTION_SIZE_RATIO);
    const resolvedLineCount = resolvedContent.split('\n').length;

    if (totalLargerSideLines >= MIN_LINES_FOR_SIZE_REGRESSION_CHECK && resolvedLineCount < expectedMinLines) {
      return {
        valid: false,
        reason: `Catastrophic size regression: resolved has ${resolvedLineCount} lines, ` +
          `expected at least ${expectedMinLines} (${nonConflictedLineCount} non-conflicted + ` +
          `${MIN_CONFLICT_RESOLUTION_SIZE_RATIO * 100}% of ${totalLargerSideLines} conflict lines)`
      };
    }
  }

  return { valid: true };
}

/**
 * Optional callbacks to persist and reuse partial conflict resolutions across runs.
 * When base-merge resolves some files but not all, we save resolved content here so the next
 * run can apply it and only run LLM on the remaining files.
 */
export interface PartialConflictResolutions {
  get: () => Record<string, string>;
  add: (file: string, content: string) => void;
  remove: (file: string) => void;
}

export async function resolveConflictsWithLLM(
  git: SimpleGit,
  conflictedFiles: string[],
  mergingBranch: string,
  workdir: string,
  config: Config,
  llm: LLMClient,
  runner: Runner | undefined,
  getCurrentModel: () => string | undefined,
  partialResolutions?: PartialConflictResolutions
): Promise<{ success: boolean; remainingConflicts: string[] }> {
  if (!workdir) {
    return { success: false, remainingConflicts: conflictedFiles };
  }

  // Mutable list of code files we still need to resolve (lock/delete handled separately)
  let codeFiles = conflictedFiles.filter(f => !isLockFile(f));
  const lockFiles = conflictedFiles.filter(f => isLockFile(f));

  console.log(chalk.cyan(`  Conflicted files (${conflictedFiles.length}):`));
  for (const file of conflictedFiles) {
    const isLock = isLockFile(file);
    console.log(chalk.cyan(`    - ${file}${isLock ? chalk.gray(' (lock file - will regenerate)') : ''}`));
  }

  // Handle lock files first - delete and regenerate
  if (lockFiles.length > 0) {
    await handleLockFileConflicts(git, lockFiles, workdir, config);
  }

  // Handle delete conflicts (e.g. "deleted by them", "deleted by us")
  // WHY: These have NO conflict markers - one side deleted the file, the other modified it.
  // The standard resolution code only handles files with <<<<<<< markers, so delete
  // conflicts fall through and get reported as unresolvable.
  const deleteConflicts = await detectDeleteConflicts(git, codeFiles, workdir);
  if (deleteConflicts.length > 0) {
    for (const dc of deleteConflicts) {
      const resolved = await resolveDeleteConflict(git, dc, workdir);
      if (resolved) {
        const idx = codeFiles.indexOf(dc.file);
        if (idx !== -1) codeFiles.splice(idx, 1);
      }
    }
  }

  // Apply saved partial resolutions from a previous run; only resolve files that still have markers
  if (partialResolutions && codeFiles.length > 0) {
    const saved = partialResolutions.get();
    const toApply = codeFiles.filter(f => saved[f]);
    if (toApply.length > 0) {
      for (const file of toApply) {
        writeFileSync(join(workdir, file), saved[file], 'utf-8');
        await git.add(file);
      }
      const stillWithMarkers = await findFilesWithConflictMarkers(workdir, codeFiles);
      for (const f of stillWithMarkers) {
        partialResolutions.remove(f);
      }
      const reusedCount = toApply.filter(f => !stillWithMarkers.includes(f)).length;
      if (reusedCount > 0) {
        console.log(chalk.green(`  Reused ${reusedCount} partial resolution(s); ${stillWithMarkers.length} file(s) still need resolution.`));
      }
      codeFiles = stillWithMarkers;
    }
  }

  // If runner not available yet (e.g., during setup phase), skip runner-based resolution
  const skipRunnerAttempt = !runner;

  // Compute model context limit for conflict resolution prompts.
  // The LLM client uses its default model (e.g., qwen-3-14b on ElizaCloud);
  // we need to respect that model's context window.
  const llmProvider = (llm as any).provider as 'elizacloud' | 'anthropic' | 'openai' | undefined;
  const llmModel = (llm as any).model as string | undefined;
  const modelMaxChars = (llmProvider && llmModel)
    ? getMaxFixPromptCharsForModel(llmProvider, llmModel)
    : MAX_CONFLICT_RESOLUTION_FILE_SIZE;
  
  // Batch size: balance gateway timeouts vs skipping the whole runner pass (audit: ~71k prompt skipped Attempt 1).
  // Scale slightly with model context; cap so weak connections still finish.
  const maxBatchPromptChars = Math.min(72_000, Math.max(40_000, Math.floor(modelMaxChars * 0.1)));

  // Handle code files with LLM tools
  if (codeFiles.length > 0 && runner) {
    const activeRunner = runner;
    const isNonAgentic = activeRunner.name === 'llm-api';
    const conflictPrompt = isNonAgentic
      ? buildConflictResolutionPromptWithContent(codeFiles, mergingBranch, workdir, modelMaxChars)
      : buildConflictResolutionPrompt(codeFiles, mergingBranch);

    if (isNonAgentic && conflictPrompt.length > maxBatchPromptChars) {
      const batches = splitConflictFilesIntoBatches(
        codeFiles,
        mergingBranch,
        workdir,
        modelMaxChars,
        maxBatchPromptChars
      );
      const runnable = batches.filter(
        b => buildConflictResolutionPromptWithContent(b, mergingBranch, workdir, modelMaxChars).length <= maxBatchPromptChars
      );
      if (runnable.length === 0) {
        console.log(
          chalk.cyan(
            `\n  Batch prompt built but too large (${formatNumber(Math.round(conflictPrompt.length / 1024))} KB); ` +
              `no batch fits under ${formatNumber(maxBatchPromptChars)} chars — using per-file resolution.`
          )
        );
      } else {
        const skippedBatches = batches.length - runnable.length;
        const skipHint =
          skippedBatches > 0
            ? ` (${formatNumber(skippedBatches)} batch(es) over budget → per-file pass)`
            : '';
        console.log(
          chalk.cyan(
            `\n  Batch prompt (${formatNumber(Math.round(conflictPrompt.length / 1024))} KB) exceeds ` +
              `${formatNumber(maxBatchPromptChars)} char budget — running ${formatNumber(runnable.length)} runner batch(es)${skipHint}.`
          )
        );
        for (let i = 0; i < runnable.length; i++) {
          const batch = runnable[i]!;
          const batchPrompt = buildConflictResolutionPromptWithContent(batch, mergingBranch, workdir, modelMaxChars);
          console.log(
            chalk.cyan(
              `  Attempt 1 (${formatNumber(i + 1)}/${formatNumber(runnable.length)}): ${activeRunner.name} — ` +
                `${formatNumber(batch.length)} file(s)...`
            )
          );
          const runResult = await activeRunner.run(workdir, batchPrompt, { model: getCurrentModel() });
          if (!runResult.success) {
            console.log(chalk.yellow(`  ${activeRunner.name} failed on batch ${i + 1}, will try direct API...`));
          } else {
            console.log(chalk.cyan('  Staging resolved files from this batch...'));
            for (const file of batch) {
              await stageRunnerOutputIfClean(git, workdir, file);
            }
          }
        }
      }
    } else {
      console.log(chalk.cyan(`\n  Attempt 1: Using ${activeRunner.name} to resolve conflicts...`));
      const runResult = await activeRunner.run(workdir, conflictPrompt, { model: getCurrentModel() });

      if (!runResult.success) {
        console.log(chalk.yellow(`  ${activeRunner.name} failed, will try direct API...`));
      } else {
        console.log(chalk.cyan('  Staging resolved files...'));
        for (const file of codeFiles) {
          await stageRunnerOutputIfClean(git, workdir, file);
        }
      }
    }
  } else if (codeFiles.length > 0 && skipRunnerAttempt) {
    console.log(chalk.blue(`\n  Skipping runner attempt (not available yet), using direct LLM API...`));
  }
  
  // Check if conflicts remain after first attempt
  // Check both git status AND actual file contents for conflict markers
  let statusAfter = await git.status();
  let gitConflicts = statusAfter.conflicted || [];
  let markerConflicts = await findFilesWithConflictMarkers(workdir, codeFiles);
  let remainingConflicts = [...new Set([...gitConflicts, ...markerConflicts])];
  
  if (remainingConflicts.length === 0 && codeFiles.length > 0 && runner) {
    const activeRunner = runner;
    console.log(chalk.green(`  ✓ ${activeRunner.name} resolved all conflicts`));
  } else if (markerConflicts.length > 0) {
    console.log(chalk.yellow(`  Files still have conflict markers: ${markerConflicts.join(', ')}`));
  }
  
  // If conflicts remain, try direct LLM API as fallback.
  // WHY conflictModel: Use same model as attempt 1 (e.g. claude-sonnet-4-5) instead of the
  // LLM client default (e.g. qwen-3-14b) which may be overloaded and 504'ing.
  if (remainingConflicts.length > 0) {
    setTokenPhase('Resolve conflicts');
    // WHY fallback chain: getCurrentModel() can return undefined during setup phase
    // (rotation state not fully initialized). Without a fallback the LLM client uses
    // its default (qwen-3-14b on ElizaCloud) which is weaker and more prone to 504s.
    // DEFAULT_ELIZACLOUD_MODEL (claude-sonnet-4-5) matches what the runner used in Attempt 1.
    const rotationModel = getCurrentModel() ?? undefined;
    const conflictModel = rotationModel
      ?? (llmProvider === 'elizacloud' ? DEFAULT_ELIZACLOUD_MODEL : undefined);
    const effectiveModel = conflictModel ?? llmModel;
    const effectiveMaxChars = (llmProvider && effectiveModel)
      ? getMaxFixPromptCharsForModel(llmProvider, effectiveModel)
      : modelMaxChars;
    // WHY derive segment cap: Each request sends base + ours + theirs (3× segment) + overhead. Small-context
    // models need smaller segments; a fixed 25k would overflow a 40k-context model. Clamp [4k, 25k] for sanity.
    const maxSegmentChars = Math.max(
      4_000,
      Math.min(25_000, Math.floor((effectiveMaxChars - CONFLICT_PROMPT_OVERHEAD_CHARS) / 3))
    );
    debug('Attempt 2 model selection', { rotationModel, conflictModel, effectiveModel, llmClientDefault: llmModel, maxSegmentChars });
    console.log(chalk.cyan(`\n  Attempt 2: Using direct ${config.llmProvider} API${conflictModel ? ` (${conflictModel})` : ''} to resolve ${remainingConflicts.length} remaining conflicts...`));
    
    const fs = await import('fs');
    const CONFLICT_HEARTBEAT_INTERVAL_MS = 30_000;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    const stopHeartbeat = (): void => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
    };
    const startHeartbeat = (): void => {
      stopHeartbeat();
      const start = Date.now();
      heartbeatTimer = setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - start) / 1000);
        console.log(chalk.gray(`  Still resolving... (${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s)`));
      }, CONFLICT_HEARTBEAT_INTERVAL_MS);
    };

    function is504OrTimeout(e: unknown): boolean {
      const msg = e instanceof Error ? e.message : String(e);
      return /504|timeout|gateway|deployment.*error|error occurred with your deployment/i.test(msg);
    }


    for (const conflictFile of remainingConflicts) {
      // Skip lock files in case they slipped through
      if (isLockFile(conflictFile)) continue;

      const fullPath = join(workdir, conflictFile);

      try {
        let conflictedContent = fs.readFileSync(fullPath, 'utf-8');
        conflictedContent = preprocessConflictFileContent(conflictedContent);
        // WHY: When the main path fails due to parse validation we pass this into the top+tails fallback
        // so the fallback prompts can tell the model to fix that specific error (e.g. close block comments).
        let lastParseError: string | undefined;

        if (!hasConflictMarkers(conflictedContent)) {
          const markerless = await resolveMarkerlessConflict(git, conflictFile, fullPath, conflictedContent);
          if (markerless.resolved) {
            console.log(chalk.green(`    ✓ ${conflictFile}: ${markerless.explanation}`));
          } else {
            console.log(
              chalk.gray(
                `    - ${conflictFile}: git still unmerged but working tree has no standard conflict markers ` +
                  `(try manual merge or delete/modify conflict)`
              )
            );
          }
          continue;
        }

        console.log(chalk.cyan(`    Resolving: ${conflictFile}`));
        if (hasNestedConflictMarkers(conflictedContent)) {
          console.log(
            chalk.yellow(
              `    Warning: nested/overlapping conflict markers in ${conflictFile} — merge may need manual cleanup; LLM/deterministic resolution can mis-merge.`
            )
          );
        }
        const fileSize = Math.round(conflictedContent.length / 1024);
        const conflictChunkCount = extractConflictChunks(conflictedContent, 0).length;
        // WHY read base here: Every LLM resolution path (chunked and single-chunk) needs base for 3-way merge.
        const baseContent = (await readConflictStage(git, conflictFile, 1)) ?? '';

        let result = tryHeuristicResolution(conflictFile, conflictedContent);
        /** Used to retry resolution once with a parse-error hint when TS/JS parse validation fails. */
        let resolutionPath: 'chunked' | 'single' | null = null;

        if (result.resolved) {
          console.log(chalk.blue(`    → Using heuristic strategy for ${conflictFile}`));
        } else if (shouldTakeTheirs(conflictFile)) {
          const theirsContent = await readConflictStage(git, conflictFile, 3);
          if (theirsContent !== null && theirsContent !== '') {
            console.log(chalk.blue(`    → Using base branch version (take theirs) for ${conflictFile}`));
            result = { resolved: true, content: theirsContent, explanation: 'Using incoming (base) version for .github/workflows' };
          }
        }
        if (!result.resolved && shouldUseDeterministicMerge(conflictFile)) {
          console.log(chalk.blue(`    → Using deterministic merge (keep ours) for ${conflictFile}`));
          result = resolveKeepOurs(conflictedContent);
        }
        if (!result.resolved && (
          isGeneratedArtifactFile(conflictFile) &&
          hasAsymmetricConflict(conflictedContent)
        )) {
          console.log(chalk.blue(`    → Using asymmetric merge for generated file (${fileSize}KB)`));
          startHeartbeat();
          try {
            result = await resolveAsymmetricConflict(
              llm,
              conflictFile,
              conflictedContent,
              mergingBranch,
              conflictModel
            );
          } finally {
            stopHeartbeat();
          }
        }
        // Use chunked when: file is large, has many conflict regions, or exceeds single-request context
        if (!result.resolved && (
          conflictedContent.length > effectiveMaxChars ||
          conflictedContent.length > CONFLICT_USE_CHUNKED_FIRST_CHARS ||
          conflictChunkCount >= CONFLICT_USE_CHUNKED_FIRST_CHUNKS
        )) {
          resolutionPath = 'chunked';
          const reason = conflictedContent.length > effectiveMaxChars
            ? `file (${fileSize}KB) exceeds model context — chunking`
            : conflictedContent.length > CONFLICT_USE_CHUNKED_FIRST_CHARS
              ? `${fileSize}KB file`
              : `${conflictChunkCount} conflict chunks`;
          console.log(chalk.blue(`    → Using chunked strategy (${reason})`));
          startHeartbeat();
          try {
            result = await resolveConflictsChunked(
              llm,
              conflictFile,
              conflictedContent,
              mergingBranch,
              conflictModel,
              baseContent,
              maxSegmentChars
            );
          } finally {
            stopHeartbeat();
          }
        }
        if (!result.resolved) {
          resolutionPath = 'single';
          if (conflictedContent.length <= MAX_CONFLICT_SINGLE_SHOT_LLM_CHARS) {
            startHeartbeat();
            try {
              const { ours: oursContent, theirs: theirsContent } = getFullFileSides(conflictedContent);
              result = await llm.resolveConflict(
                conflictFile,
                conflictedContent,
                mergingBranch,
                { ...(conflictModel ? { model: conflictModel } : {}), baseContent, oursContent, theirsContent }
              );
            } catch (e) {
              if (is504OrTimeout(e)) {
                console.log(chalk.blue(`    → Retrying with chunked strategy after 504/timeout`));
                resolutionPath = 'chunked';
                result = await resolveConflictsChunked(
                  llm,
                  conflictFile,
                  conflictedContent,
                  mergingBranch,
                  conflictModel,
                  baseContent,
                  maxSegmentChars
                );
              } else {
                const msg = e instanceof Error ? e.message : String(e);
                result = { resolved: false, content: conflictedContent, explanation: msg };
              }
            } finally {
              stopHeartbeat();
            }
          } else {
            console.log(
              chalk.blue(
                `    → Skipping single-shot LLM merge (${formatNumber(Math.round(conflictedContent.length / 1024))}KB > ${formatNumber(Math.round(MAX_CONFLICT_SINGLE_SHOT_LLM_CHARS / 1024))}KB cap — chunked path already attempted)`
              )
            );
          }
        }

        if (result.resolved) {
          // Validate resolved content before writing
          // WHY: Catches corrupted resolutions (invalid JSON, catastrophic truncation)
          // before they get committed and pushed. Better to bail to manual resolution
          // than to push garbage.
          const validation = validateResolvedContent(conflictFile, conflictedContent, result.content);
          if (!validation.valid) {
            debug('Resolution rejected by validation', { file: conflictFile, reason: validation.reason });
            result = {
              resolved: false,
              content: conflictedContent,
              explanation: `Resolution rejected: ${validation.reason}`,
            };
          } else {
            let parseValidation = await validateResolvedFileContent(result.content, conflictFile);
            let lastResult = result;
            if (!parseValidation.valid && (resolutionPath === 'chunked' || resolutionPath === 'single')) {
              // Retry resolution up to twice with parse-error hint (location + error-specific guidance).
              const maxParseRetries = 2;
              let lastParseValidation = parseValidation;
              for (let parseRetry = 0; parseRetry < maxParseRetries && !lastParseValidation.valid; parseRetry++) {
                const previousParseError = buildParseErrorRetryHint(lastParseValidation);
                console.log(chalk.blue(`    → Retrying resolution (parse error: ${lastParseValidation.error ?? 'parse error'})`));
                startHeartbeat();
                try {
                  const sides = getFullFileSides(conflictedContent);
                  const retryResult = resolutionPath === 'chunked'
                    ? await resolveConflictsChunked(
                        llm,
                        conflictFile,
                        conflictedContent,
                        mergingBranch,
                        conflictModel,
                        baseContent,
                        maxSegmentChars,
                        previousParseError
                      )
                    : conflictedContent.length <= MAX_CONFLICT_SINGLE_SHOT_LLM_CHARS
                      ? await llm.resolveConflict(
                          conflictFile,
                          conflictedContent,
                          mergingBranch,
                          {
                            ...(conflictModel ? { model: conflictModel } : {}),
                            baseContent,
                            oursContent: sides.ours,
                            theirsContent: sides.theirs,
                            previousParseError,
                          }
                        )
                      : {
                          resolved: false,
                          content: conflictedContent,
                          explanation: `File exceeds single-shot merge cap (${formatNumber(conflictedContent.length)} chars)`,
                        };
                  if (retryResult.resolved) {
                    const retryValidation = validateResolvedContent(conflictFile, conflictedContent, retryResult.content);
                    if (retryValidation.valid) {
                      lastParseValidation = await validateResolvedFileContent(retryResult.content, conflictFile);
                      if (lastParseValidation.valid) {
                        lastResult = retryResult;
                        break;
                      }
                      lastResult = retryResult;
                    }
                  }
                } finally {
                  stopHeartbeat();
                }
              }
              if (lastParseValidation.valid) {
                result = lastResult;
                parseValidation = lastParseValidation;
              } else {
                parseValidation = lastParseValidation;
              }
            }
            if (!parseValidation.valid) {
              debug('Resolution rejected by parse validation', { file: conflictFile, error: parseValidation.error });
              lastParseError = parseValidation.error;
              // One-shot syntax fix: don't discard the resolution — ask LLM to fix the reported error only.
              if (lastResult?.content) {
                console.log(chalk.blue(`    → Fixing syntax (${parseValidation.error ?? 'parse error'})...`));
                const fixed = await tryFixSyntaxWithLlm(llm, conflictFile, lastResult.content, parseValidation, conflictModel);
                if (fixed) {
                  result = { resolved: true, content: fixed.content, explanation: 'Resolved; syntax corrected by LLM.' };
                  parseValidation = { valid: true };
                }
              }
              if (!result.resolved) {
                result = {
                  resolved: false,
                  content: conflictedContent,
                  explanation: `Resolution produced invalid syntax: ${parseValidation.error ?? 'parse error'}`,
                };
              }
            }
          }
        }

        if (result.resolved) {
          // Write the validated resolved content
          fs.writeFileSync(fullPath, result.content, 'utf-8');
          console.log(chalk.green(`    ✓ ${conflictFile}: ${result.explanation}`));

          // Stage the file
          await git.add(conflictFile);
          partialResolutions?.add(conflictFile, result.content);
        } else {
          // Fallback: try top+tails strategy (whole-file story + top of conflict + tail of each side) only when main path failed.
          // WHY: We don't process the entire file with story + top/tails unless we need to; default path stays fast;
          // when the main path has already failed, this gives the model a different view (how each side ends) and often succeeds.
          console.log(chalk.blue(`    → Trying top+tails fallback (top of conflict + tail OURS + tail THEIRS)...`));
          startHeartbeat();
          let fallbackResult: { resolved: boolean; content: string; explanation: string };
          try {
            fallbackResult = await resolveConflictsWithTopTailsFallback(
              llm,
              conflictFile,
              conflictedContent,
              mergingBranch,
              conflictModel,
              baseContent,
              undefined,
              lastParseError
            );
          } finally {
            stopHeartbeat();
          }
          if (fallbackResult.resolved) {
            // WHY: Same validation as main path — size/JSON and parse — so we never stage broken output.
            const fbValidation = validateResolvedContent(conflictFile, conflictedContent, fallbackResult.content);
            if (fbValidation.valid) {
              const fbParse = await validateResolvedFileContent(fallbackResult.content, conflictFile);
              if (fbParse.valid) {
                result = fallbackResult;
                fs.writeFileSync(fullPath, result.content, 'utf-8');
                console.log(chalk.green(`    ✓ ${conflictFile}: ${result.explanation}`));
                await git.add(conflictFile);
                partialResolutions?.add(conflictFile, result.content);
              } else {
                // Syntax fix pass: top+tails content is often one error away from valid.
                console.log(chalk.blue(`    → Fixing syntax after top+tails (${fbParse.error ?? 'parse error'})...`));
                const fixed = await tryFixSyntaxWithLlm(llm, conflictFile, fallbackResult.content, fbParse, conflictModel);
                if (fixed) {
                  result = { resolved: true, content: fixed.content, explanation: 'Resolved (top+tails); syntax corrected by LLM.' };
                  fs.writeFileSync(fullPath, result.content, 'utf-8');
                  console.log(chalk.green(`    ✓ ${conflictFile}: ${result.explanation}`));
                  await git.add(conflictFile);
                  partialResolutions?.add(conflictFile, result.content);
                }
              }
            }
          }
          if (!result.resolved) {
            const reported =
              !fallbackResult.resolved && fallbackResult.explanation
                ? fallbackResult.explanation
                : result.explanation;
            console.log(chalk.red(`    ✗ ${conflictFile}: ${reported}`));
            console.log(chalk.gray(`      To resolve manually:`));
            console.log(chalk.gray(`        1. Open: ${fullPath}`));
            console.log(chalk.gray(`        2. Search for: <<<<<<<`));
            console.log(chalk.gray(`        3. Merge changes and remove conflict markers`));
            console.log(chalk.gray(`        4. Save and run: git add ${conflictFile}`));
          }
        }
      } catch (e) {
        console.log(chalk.red(`    ✗ ${conflictFile}: Error - ${e}`));
      } finally {
        stopHeartbeat();
      }
    }

    // Check again - both git status and file contents
    statusAfter = await git.status();
    gitConflicts = statusAfter.conflicted || [];
    markerConflicts = await findFilesWithConflictMarkers(workdir, codeFiles);
    remainingConflicts = [...new Set([...gitConflicts, ...markerConflicts])];
  }

  return {
    success: remainingConflicts.length === 0,
    remainingConflicts
  };
}

/**
 * Conflict type for delete/modify conflicts
 */
interface DeleteConflict {
  file: string;
  type: 'deleted-by-them' | 'deleted-by-us' | 'both-deleted';
}

/**
 * Detect delete/modify conflicts from git status.
 * 
 * WHY: When one side deletes a file and the other modifies it, git reports a conflict
 * but there are NO conflict markers in the file. These show up as:
 *   - UD (us=modified, them=deleted) → "deleted by them"
 *   - DU (us=deleted, them=modified) → "deleted by us"  
 *   - DD (both deleted) → rare but possible
 * 
 * We detect these by parsing `git status --porcelain` which shows two-char status codes.
 */
async function detectDeleteConflicts(
  git: SimpleGit,
  conflictedFiles: string[],
  workdir: string
): Promise<DeleteConflict[]> {
  const results: DeleteConflict[] = [];
  
  try {
    // Use NUL-delimited porcelain to safely handle spaces/quotes
    const raw = await git.raw(['status', '--porcelain=v1', '-z']);
    const entries = raw.split('\0').filter(Boolean);
    
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      // Entry format: XY file
      const statusCode = entry.slice(0, 2);
      let actualPath = entry.slice(3);
      if ((statusCode[0] === 'R' || statusCode[0] === 'C') && i + 1 < entries.length) {
        actualPath = entries[++i];
      }
    
      if (!conflictedFiles.includes(actualPath)) continue;
    
      if (statusCode === 'UD') {
        results.push({ file: actualPath, type: 'deleted-by-them' });
      } else if (statusCode === 'DU') {
        results.push({ file: actualPath, type: 'deleted-by-us' });
      } else if (statusCode === 'DD') {
        results.push({ file: actualPath, type: 'both-deleted' });
      }
    }
  } catch (e) {
    debug('Failed to detect delete conflicts', { error: e });
  }
  
  return results;
}

/**
 * Resolve a delete/modify conflict.
 * 
 * Strategy:
 * - "deleted by them" → Accept the deletion. The base/target branch decided the file
 *   should go. Our modifications don't matter if the file shouldn't exist.
 * - "deleted by us" → Accept the deletion. We deleted it intentionally.
 * - "both deleted" → Accept the deletion (both sides agree).
 * 
 * For all cases: `git rm <file>` to accept deletion and mark resolved.
 * 
 * Trade-off (deleted-by-them): We always accept their deletion. This can discard
 * local changes and may lose important work. This is a deliberate automated-policy
 * choice. Alternatives: make it configurable, create a backup before removal, or
 * surface a warning. We log a warning at runtime so users are informed.
 */
async function resolveDeleteConflict(
  git: SimpleGit,
  conflict: DeleteConflict,
  workdir: string
): Promise<boolean> {
  const { file, type } = conflict;
  
  try {
    switch (type) {
      case 'deleted-by-them':
        console.log(chalk.yellow(`    ⚠ ${file}: deleted by target branch — accepting deletion (local changes may be lost)`));
        break;
      case 'deleted-by-us':
        console.log(chalk.cyan(`    - ${file}: deleted by our branch, accepting deletion`));
        break;
      case 'both-deleted':
        console.log(chalk.cyan(`    - ${file}: deleted by both branches`));
        break;
    }
    
    // Accept the deletion: remove the file and mark conflict as resolved
    await git.rm(file).catch(async () => {
      // git rm may fail if file is already gone from worktree
      // Fall back to staging the deletion manually
      try {
        const { existsSync: fileExists, unlinkSync } = await import('fs');
        const fullPath = join(workdir, file);
        if (fileExists(fullPath)) {
          unlinkSync(fullPath);
        }
        await git.add(file).catch(() => {});
      } catch {
        // Last resort: just mark resolved
        await git.raw(['add', '-u', file]).catch(() => {});
      }
    });
    
    console.log(chalk.green(`    ✓ ${file}: delete conflict resolved`));
    return true;
  } catch (e) {
    console.log(chalk.red(`    ✗ ${file}: failed to resolve delete conflict: ${e}`));
    return false;
  }
}

/**
 * Clean up sync target files (CLAUDE.md, CONVENTIONS.md) that were created by prr.
 * 
 * WHY: If these files didn't exist in the original PR, we should remove them after
 * processing to avoid polluting the PR with prr-specific files.
 * 
 * @param git - SimpleGit instance
 * @param workdir - Working directory path
 * // Review: cleans up generated files only if they were not part of the original PR submission
 * @param lessonsContext - Lessons manager to check if files existed before
 */
export async function cleanupSyncTargetFiles(
  git: SimpleGit,
  workdir: string,
  lessonsContext: LessonsContext
): Promise<void> {
  const targets = ['CLAUDE.md', 'CONVENTIONS.md'];
  const targetMap: Record<string, LessonsSyncTarget> = {
    'CLAUDE.md': 'claude-md',
    'CONVENTIONS.md': 'conventions-md',
  };
  for (const file of targets) {
    try {
      const target = targetMap[file];
      const existedBefore = target ? (lessonsContext.originalSyncTargetState.get(target) ?? false) : false;
      if (existedBefore) continue;
      const fullPath = join(workdir, file);
      if (!existsSync(fullPath)) continue;
      const fs = await import('fs');
      fs.unlinkSync(fullPath);
      // Only log removal when rm or add actually succeeded. WHY: avoid claiming success when both failed.
      let removed = false;
      try {
        await git.rm(file);
        removed = true;
      } catch {
        try {
          await git.add(file);
          removed = true;
        } catch {
          // Both failed; suppress success log and let outer catch handle
        }
      }
      if (removed) {
        console.log(chalk.gray(`  Removed sync target created by prr: ${file}`));
      }
    } catch (e) {
      debug('Failed to clean up sync target', { file, error: e });
    }
  }
}
