/**
 * Fix recovery strategies for handling failures
 * 
 * Provides two recovery approaches when fixes fail:
 * 1. Single-issue focus mode - Try one issue at a time with current tool/model
 * 2. Direct LLM API fix - Bypass fixer tools and use LLM directly to rewrite files
 */

import chalk from 'chalk';
import { join } from 'path';
import type { SimpleGit } from 'simple-git';
import type { UnresolvedIssue } from '../../analyzer/types.js';
import type { StateContext } from '../../state/state-context.js';
import { setPhase } from '../../state/state-context.js';
import * as State from '../../state/state-core.js';
import * as Verification from '../../state/state-verification.js';
import * as Dismissed from '../../state/state-dismissed.js';
import * as Iterations from '../../state/state-iterations.js';
import * as Lessons from '../../state/state-lessons.js';
import type { LessonsContext } from '../../state/lessons-context.js';
import type { LLMClient } from '../../llm/client.js';
import type { Runner } from '../../runners/types.js';
import * as LessonsAPI from '../../state/lessons-index.js';
import { debug, setTokenPhase } from '../../logger.js';
import { getChangedFiles, getDiffForFile } from '../../git/git-clone-index.js';
import * as fs from 'fs';

/**
 * Try fixing issues one at a time (single-issue focus mode)
 * 
 * WHY: Batch fixes can fail because too many issues overwhelm the model.
 * Focusing on one issue at a time reduces context and improves success rate.
 * 
 * STRATEGY:
 * - Randomize order to avoid hammering the same hard issue
 * - Try up to 3 issues from the batch
 * - Build focused prompt for each issue
 * - Verify each fix before marking as successful
 * - Save lessons for failed fixes
 */
export async function trySingleIssueFix(
  issues: UnresolvedIssue[],
  git: SimpleGit,
  workdir: string,
  runner: Runner,
  stateContext: StateContext,
  lessonsContext: LessonsContext,
  llm: LLMClient,
  verifiedThisSession: Set<string> | undefined,
  buildSingleIssuePrompt: (issue: UnresolvedIssue) => string,
  getCurrentModel: () => string | null | undefined,
  parseNoChangesExplanation: (output: string) => string | null,
  sanitizeOutputForLog: (output: string | undefined, maxLength: number) => string
): Promise<boolean> {
  // Focus on one issue at a time to reduce context and improve success rate
  // Randomize which issues to try to avoid hammering the same hard issue
  const shuffled = [...issues].sort(() => Math.random() - 0.5);
  const toTry = shuffled.slice(0, Math.min(issues.length, 3));
  
  console.log(chalk.cyan(`\n  Focusing on ${toTry.length} random issues one at a time...`));
  
  let anyFixed = false;
  
  for (let i = 0; i < toTry.length; i++) {
    const issue = toTry[i];
    console.log(chalk.cyan(`\n  [${i + 1}/${toTry.length}] Focusing on: ${issue.comment.path}:${issue.comment.line || '?'}`));
    console.log(chalk.gray(`    "${issue.comment.body.split('\n')[0].substring(0, 60)}..."`));
    
    // Build a focused prompt for just this one issue
    const focusedPrompt = buildSingleIssuePrompt(issue);
    
    // Run with current runner
    const currentModel = getCurrentModel();
    const result = await runner.run(workdir, focusedPrompt, { 
      model: currentModel === null ? undefined : currentModel 
    });
    
    if (result.success) {
      // Check if this specific file changed
      const changedFiles = await getChangedFiles(git);
      
      if (changedFiles.includes(issue.comment.path)) {
        // Verify this single fix
        setTokenPhase('Verify single fix');
        const diff = await getDiffForFile(git, issue.comment.path);
        const verification = await llm.verifyFix(
          issue.comment.body,
          issue.comment.path,
          diff
        );

        if (verification.fixed) {
          console.log(chalk.green(`    ✓ Fixed and verified!`));
          debug('Fix verified successfully', {
            file: issue.comment.path,
            line: issue.comment.line,
            diffLength: diff.length,
          });
          Verification.markVerified(stateContext, issue.comment.id);
          verifiedThisSession?.add(issue.comment.id);  // Track for session filtering
          anyFixed = true;
        } else {
          console.log(chalk.yellow(`    ○ Changed but not verified: ${verification.explanation}`));
          debug('Fix rejected by verification', {
            file: issue.comment.path,
            line: issue.comment.line,
            explanation: verification.explanation,
            diff: diff.substring(0, 500),
            issueComment: issue.comment.body.substring(0, 200),
          });

          // Analyze the failure to generate an actionable lesson
          // WHY: "rejected: [reason]" isn't helpful; we need specific guidance
          setTokenPhase('Analyze failure');
          const lesson = await llm.analyzeFailedFix(
            {
              comment: issue.comment.body,
              filePath: issue.comment.path,
              line: issue.comment.line,
            },
            diff,
            verification.explanation
          );
          console.log(chalk.gray(`    📝 Lesson: ${lesson}`));
          LessonsAPI.Add.addLesson(lessonsContext, `Fix for ${issue.comment.path}:${issue.comment.line} - ${lesson}`);

          // Reset ONLY this issue's file, not all changed files
          // WHY: Other issues in this batch may have been successfully fixed
          // and we don't want to lose those changes
          try {
            await git.checkout([issue.comment.path]);
          } catch {
            // File might have been deleted from git (e.g., fixer ran git rm)
            // Try to unstage deletion, then restore from HEAD
            try {
              await git.reset(['HEAD', issue.comment.path]);
              await git.checkout([issue.comment.path]);
            } catch {
              debug(`Could not revert ${issue.comment.path} after rejected fix`);
            }
          }
        }
      } else if (changedFiles.length > 0) {
        // Tool made changes but to different files - might still be relevant
        console.log(chalk.yellow(`    ○ Changed other files instead: ${changedFiles.slice(0, 3).join(', ')}${changedFiles.length > 3 ? ` (+${changedFiles.length - 3} more)` : ''}`));
        debug('Fixer modified wrong files', {
          expectedFile: issue.comment.path,
          actualFiles: changedFiles,
          issueComment: issue.comment.body.substring(0, 200),
          toolOutput: result.output?.substring(0, 500),
        });
        // Add lesson so tool knows to focus on the right file
        LessonsAPI.Add.addLesson(lessonsContext, `Fix for ${issue.comment.path}:${issue.comment.line} - tool modified wrong files (${changedFiles.join(', ')}), need to modify ${issue.comment.path}`);
        // Reset wrong files but keep any changes to the target file
        // WHY: The target file might have partial progress worth keeping
        const wrongFiles = changedFiles.filter(f => f !== issue.comment.path);
        if (wrongFiles.length > 0) {
          try {
            await git.checkout(wrongFiles);
          } catch {
            // Some files might have been deleted from git; revert individually
            for (const f of wrongFiles) {
              try {
                await git.checkout([f]);
              } catch {
                try { await git.reset(['HEAD', f]); await git.checkout([f]); } catch { /* skip */ }
              }
            }
          }
        }
      } else {
        // Tool ran but made no changes at all
        // Parse fixer output for NO_CHANGES explanation
        const noChangesExplanation = parseNoChangesExplanation(result.output || '');

        if (noChangesExplanation) {
          console.log(chalk.gray(`    - No changes made`));
          console.log(chalk.cyan(`      Fixer's reason: ${noChangesExplanation}`));
          LessonsAPI.Add.addLesson(lessonsContext, `Fix for ${issue.comment.path}:${issue.comment.line} - ${noChangesExplanation}`);

          // If fixer says it's already fixed, dismiss this issue
          // WHY: Only match targeted phrases to avoid false positives from
          // single words like 'has' or 'exists' appearing in unrelated explanations
          const lowerExplanation = noChangesExplanation.toLowerCase();
          const isAlreadyFixed = /\balready\s+fixed\b/.test(lowerExplanation) ||
                                 /\bissue\s+already\b/.test(lowerExplanation) ||
                                 /\bno\s+changes?\s+(required|needed|necessary)\b/.test(lowerExplanation) ||
                                 /\bno\s+fix\s+needed\b/.test(lowerExplanation) ||
                                 /\bnothing\s+to\s+(do|fix|change)\b/.test(lowerExplanation) ||
                                 /\bnot\s+reproducible\b/.test(lowerExplanation) ||
                                 /\balready\s+(exists?|implemented|addressed|resolved|correct)\b/.test(lowerExplanation);

          if (isAlreadyFixed) {
            Dismissed.dismissIssue(
              stateContext,
              issue.comment.id,
              `Fixer tool (single-issue mode) reported: ${noChangesExplanation}`,
              'already-fixed',
              issue.comment.path,
              issue.comment.line,
              issue.comment.body
            );
          }
        } else {
          // No explanation provided - this is a problem but not fatal
          console.log(chalk.yellow(`    - No changes made (fixer didn't explain why)`));
          console.log(chalk.gray(`      Tip: Will rotate to different model/tool on next attempt`));
          LessonsAPI.Add.addLesson(lessonsContext, `Fix for ${issue.comment.path}:${issue.comment.line} - tool made no changes without explanation, trying different approach`);
          
          // Only show debug details in verbose mode, and sanitize output
          debug('Fixer made no changes', {
            targetFile: issue.comment.path,
            targetLine: issue.comment.line,
            promptLength: focusedPrompt.length,
            toolOutput: sanitizeOutputForLog(result.output, 300),
          });
        }
      }
    } else {
      console.log(chalk.red(`    ✗ Failed: ${result.error}`));
      debug('Fixer tool failed', {
        file: issue.comment.path,
        line: issue.comment.line,
        error: result.error,
        output: result.output?.substring(0, 500),
      });
    }
    
    await State.saveState(stateContext);
    await LessonsAPI.Save.save(lessonsContext);
  }
  
  return anyFixed;
}

/**
 * Try direct LLM API fix (last resort)
 * 
 * WHY: When fixer tools fail repeatedly, bypass them and use LLM directly.
 * The LLM reads the full file, applies the fix, and writes back the complete file.
 * 
 * STRATEGY:
 * - Read current file content
 * - Build prompt with issue + code snippet + full file
 * - Ask LLM for complete fixed file
 * - Write fixed file
 * - Verify the fix
 * - If verification fails, revert the file
 */
export async function tryDirectLLMFix(
  issues: UnresolvedIssue[],
  git: SimpleGit,
  workdir: string,
  llmProvider: string,
  llm: LLMClient,
  stateContext: StateContext,
  verifiedThisSession: Set<string> | undefined
): Promise<boolean> {
  console.log(chalk.cyan(`\n  🧠 Attempting direct ${llmProvider} API fix...`));
  setTokenPhase('Direct LLM fix');
  
  let anyFixed = false;
  
  // Maximum file size to embed in prompt (128KB). Larger files would exceed
  // model context limits and waste tokens.
  const MAX_PROMPT_FILE_BYTES = 128 * 1024;

  for (const issue of issues) {
    const filePath = join(workdir, issue.comment.path);
    
    try {
      // Guard against large files exceeding model context
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_PROMPT_FILE_BYTES) {
        console.log(chalk.gray(`    - Skipped ${issue.comment.path}: file too large (${Math.round(stat.size / 1024)}KB > ${MAX_PROMPT_FILE_BYTES / 1024}KB limit)`));
        continue;
      }

      const fileContent = fs.readFileSync(filePath, 'utf-8');
      
      const prompt = `Fix this code review issue:

FILE: ${issue.comment.path}
ISSUE: ${issue.comment.body}

CURRENT CODE:
\`\`\`
${issue.codeSnippet}
\`\`\`

FULL FILE:
\`\`\`
${fileContent}
\`\`\`

Provide the COMPLETE fixed file content. Output ONLY the code, no explanations.
Start your response with \`\`\` and end with \`\`\`.`;

      const response = await llm.complete(prompt);
      
      // Extract code from response
      const codeMatch = response.content.match(/```[\w]*\n?([\s\S]*?)```/);
      if (codeMatch) {
        const fixedCode = codeMatch[1].trim();
        const fileContentTrimmed = fileContent.trimEnd();
        if (fixedCode !== fileContentTrimmed) {
          // Preserve trailing newline if original file had one
          const hasTrailingNewline = fileContent.endsWith('\n');
          fs.writeFileSync(filePath, fixedCode + (hasTrailingNewline ? '\n' : ''), 'utf-8');
          
          // If file was staged for deletion, unstage it so we can add it back
          const status = await git.status([issue.comment.path]).catch(() => null);
          if (status?.deleted?.includes(issue.comment.path)) {
            await git.reset(['HEAD', issue.comment.path]).catch(() => {});
          }
          
          console.log(chalk.green(`    ✓ Written: ${issue.comment.path}`));

          // Verify the fix before counting it as successful
          // WHY: Direct LLM writes code but we need to verify it addresses the issue
          // Without this, the fix could be wrong and get undone by next fixer iteration
          setTokenPhase('Verify single fix');
          const diff = await getDiffForFile(git, issue.comment.path);
          const verification = await llm.verifyFix(
            issue.comment.body,
            issue.comment.path,
            diff
          );

          if (verification.fixed) {
            console.log(chalk.green(`    ✓ Verified: ${issue.comment.path}`));
            Verification.markVerified(stateContext, issue.comment.id);
            verifiedThisSession?.add(issue.comment.id);
            anyFixed = true;
          } else {
            console.log(chalk.yellow(`    ○ Not verified: ${verification.explanation}`));
            // Reset the file - the fix wasn't correct
            // First check if file exists in git
            const tracked = await git.raw(['ls-files', issue.comment.path]).catch(() => '');
            if (tracked.trim()) {
              await git.checkout([issue.comment.path]).catch(async (err) => {
                // If file is staged for deletion, unstage it first
                try {
                  await git.reset(['HEAD', issue.comment.path]);
                } catch { /* ignore reset failures */ }
                console.log(chalk.yellow(`    Warning: Could not reset ${issue.comment.path}: ${err.message}`));
              });
            } else {
              // File is untracked, just delete it
              try {
                fs.unlinkSync(filePath);
              } catch {}
            }
          }
        } else {
          // LLM returned the same code - no changes needed
          console.log(chalk.gray(`    - No changes needed for ${issue.comment.path}`));
          console.log(chalk.cyan(`      Direct LLM indicated file is already correct`));
          // Document this dismissal
          Dismissed.dismissIssue(
            stateContext,
            issue.comment.id,
            `Direct LLM API returned unchanged code, indicating the issue is already addressed or not applicable`,
            'already-fixed',
            issue.comment.path,
            issue.comment.line,
            issue.comment.body
          );
        }
      }
    } catch (e) {
      console.log(chalk.gray(`    - Skipped ${issue.comment.path}: ${e}`));
    }
  }
  
  return anyFixed;
}
