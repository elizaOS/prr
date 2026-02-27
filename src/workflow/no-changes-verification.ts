/**
 * No-changes verification workflow
 * 
 * Handles the case when the fixer runs successfully but makes no changes.
 * Key scenarios:
 * 1. Fixer claims issues are already fixed - verify the claim
 * 2. Fixer couldn't fix for other reasons - document and rotate
 * 3. Fixer made no changes without explanation - rotate to different approach
 */

import chalk from 'chalk';
import type { UnresolvedIssue } from '../analyzer/types.js';
import type { StateContext } from '../state/state-context.js';
import { getState } from '../state/state-context.js';
import * as Verification from '../state/state-verification.js';
import * as Performance from '../state/state-performance.js';
import type { LessonsContext } from '../state/lessons-context.js';
import type { LLMClient } from '../llm/client.js';
import * as LessonsAPI from '../state/lessons-index.js';
import { debug, formatNumber } from '../logger.js';
import { parseResultCode } from './utils.js';

/**
 * Number of issues to spot-check before committing to full verification.
 * WHY: When the fixer claims "already fixed" but made zero changes, it's
 * unlikely ALL issues are actually fixed. Spot-checking a small sample first
 * avoids wasting tokens on a full batch verification of 80+ issues when the
 * claim is bogus (e.g., garbled output or model confusion).
 */
const SPOT_CHECK_SAMPLE_SIZE = 5;

/**
 * Minimum ratio of spot-check issues verified as fixed to proceed with full check.
 * If fewer than this fraction pass, we reject the claim without checking the rest.
 */
const SPOT_CHECK_PASS_THRESHOLD = 0.4; // At least 2 out of 5 must pass

/**
 * Guess the package.json path for a source file.
 * packages/ and plugins/ use 2-segment packages (packages/typescript/package.json).
 * examples/ uses 3-segment packages (examples/chat/typescript/package.json).
 * Fallback: dirname of the file + /package.json.
 */
function guessPackageJsonPath(filePath: string): string | null {
  const parts = filePath.split('/');
  if (parts.length >= 3 && (parts[0] === 'packages' || parts[0] === 'plugins')) {
    return `${parts[0]}/${parts[1]}/package.json`;
  }
  if (parts.length >= 4 && parts[0] === 'examples') {
    return `${parts[0]}/${parts[1]}/${parts[2]}/package.json`;
  }
  const dir = filePath.includes('/') ? filePath.replace(/\/[^/]+$/, '') : '.';
  return dir ? `${dir}/package.json` : 'package.json';
}

/**
 * Handle no-changes scenario after fixer runs
 * 
 * WHY: When a fixer makes no changes, it could mean:
 * - Issues are already fixed (need to verify)
 * - Fixer couldn't understand the issue (need different approach)
 * - Fixer hit a limitation (need rotation)
 * 
 * WORKFLOW:
 * 1. Parse fixer's explanation for why no changes were made
 * 2. If fixer claims "already fixed", verify each issue with LLM
 * 3. Mark verified issues as fixed and remove from unresolved list
 * 4. Track no-changes for performance stats
 * 5. Return whether to continue, break, or proceed to rotation
 */
export async function handleNoChangesWithVerification(
  unresolvedIssues: UnresolvedIssue[],
  runnerName: string,
  currentModel: string | undefined,
  fixerOutput: string,
  llm: LLMClient,
  stateContext: StateContext,
  lessonsContext: LessonsContext,
  verifiedThisSession: Set<string>,
  parseNoChangesExplanation: (output: string) => string | null
): Promise<{
  shouldBreak: boolean;
  shouldContinue: boolean;
  verifiedCount: number;
  updatedUnresolvedIssues: UnresolvedIssue[];
  progressMade: number;
}> {
  console.log(chalk.yellow(`\nNo changes made by ${runnerName}${currentModel ? ` (${currentModel})` : ''}`));

  // WHY try RESULT first: Structured codes (ALREADY_FIXED, UNCLEAR, WRONG_LOCATION, etc.) allow
  // targeted lessons and routing. When none is present, fall back to parseNoChangesExplanation so
  // legacy NO_CHANGES: and inferred explanations still work.
  let noChangesExplanation: string | null = null;
  const structuredResult = parseResultCode(fixerOutput);
  if (structuredResult) {
    console.log(chalk.cyan(`  Result: ${structuredResult.resultCode} — ${structuredResult.resultDetail}`));
    switch (structuredResult.resultCode) {
      case 'ALREADY_FIXED':
        noChangesExplanation = `already fixed - ${structuredResult.resultDetail}`;
        break;
      case 'UNCLEAR':
      case 'CANNOT_FIX': {
        // File-specific lesson so the failure is associated with this file/issue for future runs.
        const firstIssue0 = unresolvedIssues[0];
        const detail = structuredResult.resultDetail?.substring(0, 200) ?? structuredResult.resultCode;
        if (firstIssue0) {
          LessonsAPI.Add.addLesson(lessonsContext, `Fix for ${firstIssue0.comment.path}:${firstIssue0.comment.line} - ${structuredResult.resultCode}: ${detail}`);
        } else {
          LessonsAPI.Add.addGlobalLesson(lessonsContext, `${structuredResult.resultCode}: ${detail}`);
        }
        Performance.recordModelNoChanges(stateContext, runnerName, currentModel);
        return {
          shouldBreak: false,
          shouldContinue: false,
          verifiedCount: 0,
          updatedUnresolvedIssues: unresolvedIssues,
          progressMade: 0,
        };
      }
      case 'WRONG_LOCATION': {
        const firstIssue1 = unresolvedIssues[0];
        const wrongDetail = `WRONG_LOCATION: ${structuredResult.resultDetail} — provide wider code context`;
        if (firstIssue1) {
          LessonsAPI.Add.addLesson(lessonsContext, `Fix for ${firstIssue1.comment.path}:${firstIssue1.comment.line} - ${wrongDetail}`);
        } else {
          LessonsAPI.Add.addGlobalLesson(lessonsContext, wrongDetail);
        }
        Performance.recordModelNoChanges(stateContext, runnerName, currentModel);
        return {
          shouldBreak: false,
          shouldContinue: false,
          verifiedCount: 0,
          updatedUnresolvedIssues: unresolvedIssues,
          progressMade: 0,
        };
      }
      case 'NEEDS_DISCUSSION': {
        // Make the lesson file-specific so it informs future fix attempts on the same file.
        const firstIssue2 = unresolvedIssues[0];
        const ndDetail = structuredResult.resultDetail?.substring(0, 200) ?? 'requires discussion';
        if (firstIssue2) {
          LessonsAPI.Add.addLesson(lessonsContext, `Fix for ${firstIssue2.comment.path}:${firstIssue2.comment.line} - NEEDS_DISCUSSION: ${ndDetail}`);
        } else {
          LessonsAPI.Add.addGlobalLesson(lessonsContext, `NEEDS_DISCUSSION: ${ndDetail}`);
        }
        // When fixer says the fix requires another file (e.g. package.json), expand scope on retry.
        const detail = (structuredResult.resultDetail ?? '').toLowerCase();
        const needsOtherFile = /package\.json|outside the scope|cannot edit|requires? editing|different file|that file/i.test(detail);
        let updated = unresolvedIssues;
        if (needsOtherFile && unresolvedIssues.length > 0) {
          const extraPath = guessPackageJsonPath(unresolvedIssues[0]!.comment.path);
          if (extraPath) {
            updated = unresolvedIssues.map((issue, i) => {
              // Expand scope for the issue(s) that were in this fix attempt (single-issue: first only)
              if (i > 0) return issue;
              const paths = new Set<string>([issue.comment.path, extraPath]);
              return { ...issue, allowedPaths: Array.from(paths) };
            });
            debug('Expanded fix scope for NEEDS_DISCUSSION', { path: extraPath, issuePath: unresolvedIssues[0]!.comment.path });
          }
        }
        Performance.recordModelNoChanges(stateContext, runnerName, currentModel);
        return {
          shouldBreak: false,
          shouldContinue: false,
          verifiedCount: 0,
          updatedUnresolvedIssues: updated,
          progressMade: 0,
        };
      }
      default:
        // FIXED, ATTEMPTED: shouldn't reach here (they make changes). Fall back to legacy parsing.
        noChangesExplanation = parseNoChangesExplanation(fixerOutput);
    }
  } else {
    noChangesExplanation = parseNoChangesExplanation(fixerOutput);
  }

  let verifiedCount = 0;
  let progressMade = 0;
  let shouldBreak = false;
  let shouldContinue = false;

  if (noChangesExplanation) {
    // Fixer provided an explanation for why it made no changes
    console.log(chalk.cyan(`  Fixer's explanation: ${noChangesExplanation}`));

    // WHY regex with word boundaries: Single words like 'has'/'exists' match too broadly
    // (e.g. "This has not been resolved", "The file no longer exists").
    // Regex \b boundaries + compound phrases prevent false positives.
    const lowerExplanation = noChangesExplanation.toLowerCase();
    const isAlreadyFixed = /\balready\s+fixed\b/.test(lowerExplanation) ||
                           /\bissue\s+already\b/.test(lowerExplanation) ||
                           /\bno\s+changes?\s+(required|needed|necessary)\b/.test(lowerExplanation) ||
                           /\bno\s+fix\s+needed\b/.test(lowerExplanation) ||
                           /\bnothing\s+to\s+(do|fix|change)\b/.test(lowerExplanation) ||
                           /\bnot\s+reproducible\b/.test(lowerExplanation) ||
                           /\balready\s+(exists?|implemented|addressed|resolved|correct|handled|present)\b/.test(lowerExplanation);

    // Defer lesson addition for ALREADY_FIXED claims until after verification.
    // WHY: Adding "Fixer made no changes: already fixed at lines X" as a lesson
    // BEFORE verification poisons subsequent prompts when the verifier disagrees.
    // The fixer sees its own prior (wrong) claim as a lesson and doubles down.
    if (!isAlreadyFixed) {
      LessonsAPI.Add.addGlobalLesson(lessonsContext, `Fixer made no changes: ${noChangesExplanation}`);
    }

    if (isAlreadyFixed) {
      // Fixer claims issues are already fixed - VERIFY the claim
      console.log(chalk.gray(`  → Fixer believes issues are already addressed - verifying...`));
      
      // SPOT-CHECK: When there are many issues, verify a small sample first.
      // If the sample fails, skip the expensive full verification.
      const needsSpotCheck = unresolvedIssues.length > SPOT_CHECK_SAMPLE_SIZE * 2;
      
      if (needsSpotCheck) {
        debug('Spot-checking NO_CHANGES claim', { total: unresolvedIssues.length, sampleSize: SPOT_CHECK_SAMPLE_SIZE });
        const sample = unresolvedIssues.slice(0, SPOT_CHECK_SAMPLE_SIZE);
        // Use issue_N IDs so LLM response "issue_1: YES:" matches (normalizeIssueId expects issue_N).
        const spotResults = await llm.batchCheckIssuesExist(
          sample.map((issue, idx) => ({
            id: `issue_${idx + 1}`,
            comment: issue.comment.body,
            filePath: issue.comment.path,
            line: issue.comment.line,
            codeSnippet: issue.codeSnippet,
          })),
          undefined,
          80_000,
          8
        );
        
        let spotFixed = 0;
        for (let i = 0; i < sample.length; i++) {
          const result = spotResults.issues.get(`issue_${i + 1}`);
          if (result && !result.exists) spotFixed++;
        }
        
        const passRatio = spotFixed / SPOT_CHECK_SAMPLE_SIZE;
        debug('Spot-check results', { spotFixed, total: SPOT_CHECK_SAMPLE_SIZE, passRatio });
        
        if (passRatio < SPOT_CHECK_PASS_THRESHOLD) {
          console.log(chalk.yellow(`  → Spot-check rejected claim (${spotFixed}/${SPOT_CHECK_SAMPLE_SIZE} verified) - skipping full verification`));
          // Fall through to normal rotation logic
        } else {
          console.log(chalk.gray(`  → Spot-check passed (${spotFixed}/${SPOT_CHECK_SAMPLE_SIZE}) - running full verification...`));
          // Fall through to full verification below
        }
        
        // Only proceed to full verification if spot-check passed
        if (passRatio < SPOT_CHECK_PASS_THRESHOLD) {
          // Skip to rotation — don't waste tokens on the remaining issues
          // (falls through to the end of this block)
        } else {
          // Full verification (spot-check passed)
          const fullResult = await verifyAllIssues(unresolvedIssues, llm, stateContext, runnerName, currentModel, verifiedThisSession);
          if (fullResult) {
            return fullResult;
          }
          // If fullResult is null, no issues were verified — fall through to rotation
        }
      } else {
        // Small number of issues — verify all directly (no spot-check needed)
        const fullResult = await verifyAllIssues(unresolvedIssues, llm, stateContext, runnerName, currentModel, verifiedThisSession);
        if (fullResult) {
          return fullResult;
        }
        // If fullResult is null, no issues were verified — fall through
      }
      
      // Fixer's claim was wrong or spot-check rejected it
      console.log(chalk.yellow(`  → Fixer's claim not verified - issues still exist`));
      // Fall through to normal rotation logic (return with shouldContinue=false)
    } else {
      // Fixer couldn't fix for other reasons (unclear instructions, etc.) - document but don't dismiss
      console.log(chalk.gray(`  → This will be recorded for feedback loop`));
    }
  } else {
    // Fixer made zero changes WITHOUT a parseable explanation.
    // The raw output may still contain useful reasoning (e.g., "the code already
    // handles this" or "I couldn't find the referenced function").
    // Extract the tail of the output which typically has the model's final summary.
    console.log(chalk.yellow(`  Fixer didn't explain why no changes were made`));
    console.log(chalk.gray(`  → Will try different model/tool approach`));

    // WHY extract the tail: Fixer output is often 20K+ chars of tool calls and
    // file reads, with the actual reasoning in the last few hundred characters.
    // A generic "no changes" lesson is useless, but "Output tail: the function
    // already handles this case via the guard on line 42" gives the next attempt
    // real context. 500 chars balances capturing the summary without storing the
    // entire tool trace.
    //
    // WHY strip tool_call/tool_result: These XML blocks are agentic tool metadata
    // (file reads, shell commands) that obscure the model's actual reasoning.
    // Stripping them surfaces the natural-language explanation buried underneath.
    //
    // WHY 150-char lesson cap: Lessons are embedded in every subsequent prompt.
    // Long lessons waste tokens; a compressed summary is enough to steer the
    // next attempt.
    if (fixerOutput && fixerOutput.length > 100) {
      const tail = fixerOutput.slice(-500).trim();
      const cleaned = tail
        .replace(/\[tool_call\][\s\S]*?\[\/tool_call\]/g, '')
        .replace(/\[tool_result\][\s\S]*?\[\/tool_result\]/g, '')
        .trim();

      if (cleaned.length > 30) {
        const preview = cleaned.length > 200 ? cleaned.substring(cleaned.length - 200) : cleaned;
        debug('No-change output tail', { preview });
        LessonsAPI.Add.addGlobalLesson(
          lessonsContext,
          `Fixer made no changes. Output tail: ${preview.replace(/\n/g, ' ').substring(0, 150)}`
        );
      } else {
        LessonsAPI.Add.addGlobalLesson(lessonsContext, 'Fixer made no changes without explanation — trying different approach');
      }
    } else {
      LessonsAPI.Add.addGlobalLesson(lessonsContext, 'Fixer made no changes without explanation — trying different approach');
    }
  }

  // Track no-changes for performance stats
  Performance.recordModelNoChanges(stateContext, runnerName, currentModel);
  
  return {
    shouldBreak: false,
    shouldContinue: false, // Will proceed to rotation strategy
    verifiedCount,
    updatedUnresolvedIssues: unresolvedIssues,
    progressMade,
  };
}

/**
 * Verify all unresolved issues and return result if any were verified.
 * Returns null if none were verified (caller should fall through to rotation).
 */
async function verifyAllIssues(
  unresolvedIssues: UnresolvedIssue[],
  llm: LLMClient,
  stateContext: StateContext,
  runnerName: string,
  currentModel: string | undefined,
  verifiedThisSession: Set<string>
): Promise<{
  shouldBreak: boolean;
  shouldContinue: boolean;
  verifiedCount: number;
  updatedUnresolvedIssues: UnresolvedIssue[];
  progressMade: number;
} | null> {
  const verifyResults = await llm.batchCheckIssuesExist(
    unresolvedIssues.map((issue, idx) => ({
      id: `issue_${idx + 1}`,
      comment: issue.comment.body,
      filePath: issue.comment.path,
      line: issue.comment.line,
      codeSnippet: issue.codeSnippet,
    })),
    undefined,
    80_000,
    8
  );
  
  let verifiedAsFixed = 0;
  const stillUnresolved: typeof unresolvedIssues = [];
  
  for (let i = 0; i < unresolvedIssues.length; i++) {
    const issue = unresolvedIssues[i];
    const result = verifyResults.issues.get(`issue_${i + 1}`);
    
    if (result && !result.exists) {
      verifiedAsFixed++;
      Verification.markVerified(stateContext, issue.comment.id);
      verifiedThisSession.add(issue.comment.id);
      console.log(chalk.greenBright(`    ✓ RESOLVED: ${issue.comment.path}:${issue.comment.line} — ${result.explanation}`));
    } else {
      if (result) {
        issue.verifierContradiction = result.explanation;
        // WHY track rejection: Same as fix-verification path — after N rejections we dismiss as "exhausted"
        // so we stop retrying this issue and avoid infinite fixer/verifier stalemates (see solvability Check 0e).
        const state = getState(stateContext);
        if (!state.verifierRejectionCount) state.verifierRejectionCount = {};
        state.verifierRejectionCount[issue.comment.id] = (state.verifierRejectionCount[issue.comment.id] ?? 0) + 1;
        console.log(chalk.yellow(`    ○ Still exists: ${issue.comment.path}:${issue.comment.line} - ${result.explanation}`));
      }
      stillUnresolved.push(issue);
    }
  }
  
  if (verifiedAsFixed > 0) {
    console.log(chalk.green(`  → Verified ${formatNumber(verifiedAsFixed)}/${formatNumber(unresolvedIssues.length)} issues as already fixed`));
    Performance.recordModelFix(stateContext, runnerName, currentModel, verifiedAsFixed);
    
    // Update unresolved list
    unresolvedIssues.splice(0, unresolvedIssues.length, ...stillUnresolved);
    
    if (unresolvedIssues.length === 0) {
      console.log(chalk.green('\n✓ All issues verified as already fixed'));
      return {
        shouldBreak: true,
        shouldContinue: false,
        verifiedCount: verifiedAsFixed,
        updatedUnresolvedIssues: unresolvedIssues,
        progressMade: verifiedAsFixed,
      };
    }
    
    // Some verified, some remain - continue with remaining
    return {
      shouldBreak: false,
      shouldContinue: true,
      verifiedCount: verifiedAsFixed,
      updatedUnresolvedIssues: unresolvedIssues,
      progressMade: verifiedAsFixed,
    };
  }
  
  // None verified — return null to signal caller should fall through
  return null;
}
