/**
 * Git conflict resolution prompts
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { extractConflictChunks } from './git-conflict-chunked.js';

/** Above this size we embed only conflict sections, not the full file. WHY: Large files (e.g. CHANGELOG 600+ lines) double prompt size and cause 504s; conflict sections are enough for <search>/<replace>. */
const CONFLICT_EMBED_FULL_MAX_CHARS = 30_000;

/**
 * Build prompt for agentic runners (Cursor, Claude Code, Aider) that can open files.
 */
export function buildConflictResolutionPrompt(conflictedFiles: string[], baseBranch: string): string {
  const fileList = conflictedFiles.map(f => `- ${f}`).join('\n');
  
  return `MERGE CONFLICT RESOLUTION

The following files have merge conflicts that need to be resolved:

${fileList}

These conflicts occurred while merging '${baseBranch}' into the current branch.

INSTRUCTIONS:
1. Open each conflicted file
2. Look for conflict markers: <<<<<<<, =======, >>>>>>>
3. For each conflict:
   - Understand what both sides are trying to do
   - Choose the correct resolution that preserves the intent of both changes
   - Remove all conflict markers
4. Ensure the code compiles/runs correctly after resolution
5. Save all files

IMPORTANT:
- Do NOT just pick one side blindly
- Merge the changes intelligently, combining both when possible
- Pay special attention to imports, function signatures, and data structures
- For lock files (bun.lock, package-lock.json, yarn.lock), regenerate them by running the package manager install command
- For configuration files, ensure all necessary entries from both sides are preserved

After resolving, the files should have NO conflict markers remaining.`;
}

/**
 * Build prompt for non-agentic runners (llm-api) that cannot open files.
 * Embeds the actual conflicted file content so the LLM can produce
 * search/replace blocks against real content instead of hallucinating.
 * 
 * Files are included up to maxTotalChars to respect model context limits.
 * Files that exceed the budget are listed but not embedded.
 */
export function buildConflictResolutionPromptWithContent(
  conflictedFiles: string[],
  baseBranch: string,
  workdir: string,
  maxTotalChars: number
): string {
  const parts: string[] = [
    'MERGE CONFLICT RESOLUTION',
    '',
    `These conflicts occurred while merging '${baseBranch}' into the current branch.`,
    '',
  ];

  let charsUsed = 0;
  const skipped: string[] = [];

  for (const file of conflictedFiles) {
    let content: string;
    try {
      content = readFileSync(join(workdir, file), 'utf-8');
    } catch {
      skipped.push(file);
      continue;
    }

    const hasConflictMarkers = content.includes('<<<<<<<');
    const useChunkedEmbed = hasConflictMarkers && content.length > CONFLICT_EMBED_FULL_MAX_CHARS;

    if (useChunkedEmbed) {
      const chunks = extractConflictChunks(content, 7);
      // Malformed conflict (no closing >>>>>>>) — embed full file so LLM can still attempt resolution.
      if (chunks.length === 0) {
        parts.push(`--- FILE: ${file} ---`);
        parts.push(content);
        parts.push(`--- END: ${file} ---`);
        parts.push('');
        charsUsed += content.length;
      } else {
        let sectionChars = 0;
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const segment = chunk.fullContent;
          if (charsUsed + sectionChars + segment.length > maxTotalChars) break;
          // WHY line range from context arrays: header should match what we actually embed (contextBefore + conflict + contextAfter), not just conflict marker lines.
          const embedStart = chunk.startLine - chunk.contextBefore.length + 1;
          const embedEnd = chunk.endLine + chunk.contextAfter.length + 1;
          parts.push(`--- FILE: ${file} (section ${i + 1}/${chunks.length}, lines ${embedStart}-${embedEnd}) ---`);
          parts.push(segment);
          parts.push(`--- END: ${file} section ${i + 1} ---`);
          parts.push('');
          sectionChars += segment.length;
        }
        charsUsed += sectionChars;
        if (sectionChars === 0) skipped.push(file);
      }
    } else {
      if (charsUsed + content.length > maxTotalChars) {
        skipped.push(file);
        continue;
      }
      parts.push(`--- FILE: ${file} ---`);
      parts.push(content);
      parts.push(`--- END: ${file} ---`);
      parts.push('');
      charsUsed += content.length;
    }
  }

  if (skipped.length > 0) {
    parts.push(`Files too large for this model (resolve manually): ${skipped.join(', ')}`);
    parts.push('');
  }

  // Plain file path in <change path="...">: section headers include "(section 1/N, lines X-Y)" but path must be the real filename so the applier can find the file. WHY: LLMs sometimes echo the header; clarifying avoids wrong paths.
  parts.push(
    'INSTRUCTIONS:',
    '1. For each file (or file section) above, find the conflict markers: <<<<<<<, =======, >>>>>>>',
    '2. Understand what both sides are trying to do',
    '3. Choose the correct resolution that preserves the intent of both changes',
    '4. Remove ALL conflict markers',
    '5. Output a <change path="filename"> block for each file/section with <search> containing the conflicted section and <replace> containing the resolved code. Use the plain file path (e.g. "CHANGELOG.md"), not the section annotation.',
    '',
    'IMPORTANT:',
    '- Do NOT just pick one side blindly',
    '- Merge the changes intelligently, combining both when possible',
    '- Pay special attention to imports, function signatures, and data structures',
    '- The <search> text must match the file content EXACTLY (including conflict markers)',
    '',
    'After resolving, NO conflict markers should remain.',
  );

  return parts.join('\n');
}
