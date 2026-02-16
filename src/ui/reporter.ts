/**
 * UI/Reporting functions for PR resolution results.
 * Extracted from PRResolver to reduce file size and improve modularity.
 */
import chalk from 'chalk';
import type { ReviewComment } from '../github/types.js';
import type { StateContext } from '../state/state-context.js';
import { getState } from '../state/state-context.js';
import * as Performance from '../state/state-performance.js';
import * as Verification from '../state/state-verification.js';
import * as Dismissed from '../state/state-dismissed.js';
import type { LessonsContext } from '../state/lessons-context.js';
import * as LessonsAPI from '../state/lessons-index.js';

/**
 * Sanitize a review comment body for human-readable terminal output.
 * Strips HTML tags, massive URLs (JWT tokens, data URIs, tracking links),
 * markdown images, and collapses whitespace.
 */
export function sanitizeCommentForDisplay(body: string): string {
  let text = body;
  
  // Strip HTML comments (<!-- ... -->) including BugBot metadata
  text = text.replace(/<!--[\s\S]*?-->/g, '');
  
  // Strip entire <p> blocks that contain only links/images (BugBot "Fix in Cursor" buttons)
  text = text.replace(/<p>\s*<a[^>]*>[\s\S]*?<\/a>(?:\s*&nbsp;\s*<a[^>]*>[\s\S]*?<\/a>)*\s*<\/p>/gi, '');
  
  // Strip <picture> blocks (contain <source>/<img> for dark/light mode badges)
  text = text.replace(/<picture>[\s\S]*?<\/picture>/gi, '');
  
  // Strip <details> blocks (collapsed sections with secondary info)
  text = text.replace(/<details>[\s\S]*?<\/details>/gi, '');
  
  // Strip markdown images: ![alt](url) and HTML <img> tags
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  text = text.replace(/<img[^>]*\/?>/gi, '');
  
  // Strip <a> tags that wrap non-text content (images, badges) — remove entirely
  text = text.replace(/<a[^>]*>\s*<(?:picture|img)[^]*?<\/a>/gi, '');
  
  // Strip remaining <a> tags but keep their text content
  text = text.replace(/<a[^>]*>([\s\S]*?)<\/a>/gi, '$1');
  
  // Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');
  
  // Strip standalone URLs longer than 60 chars (JWT tokens, tracking links, data URIs)
  text = text.replace(/https?:\/\/\S{60,}/g, '');
  
  // Strip markdown links where the URL is very long: [text](huge-url) → text
  text = text.replace(/\[([^\]]*)\]\(https?:\/\/\S{60,}\)/g, '$1');
  
  // Strip HTML entities
  text = text.replace(/&nbsp;/g, ' ');
  text = text.replace(/&[a-z]+;/gi, '');
  
  // Collapse multiple blank lines into one
  text = text.replace(/\n{3,}/g, '\n\n');
  
  // Collapse leading/trailing whitespace per line, drop empty lines at start/end
  text = text.split('\n').map(l => l.trim()).join('\n').trim();
  
  return text;
}

/**
 * Unresolved issue with explanation
 */
export interface UnresolvedIssue {
  comment: ReviewComment;
  explanation: string;
}

/**
 * Format a number with commas (e.g., 1234 -> "1,234")
 */
export function formatNumber(num: number): string {
  return num.toLocaleString();
}

/**
 * Print model performance statistics
 */
export function printModelPerformance(stateContext: StateContext | null): void {
  if (!stateContext) return;
  
  const models = Performance.getModelsBySuccessRate(stateContext);
  if (models.length === 0) return;
  
  console.log(chalk.cyan('\n📊 Model Performance:'));
  
  for (const { key, stats, successRate } of models) {
    const total = stats.fixes + stats.failures;
    if (total === 0 && stats.noChanges === 0 && stats.errors === 0) continue;
    
    const pct = total > 0 ? Math.round(successRate * 100) : 0;
    const successColor = pct >= 70 ? chalk.green : pct >= 40 ? chalk.yellow : chalk.red;
    
    const parts: string[] = [];
    if (stats.fixes > 0) parts.push(chalk.green(`${formatNumber(stats.fixes)} fixes`));
    if (stats.failures > 0) parts.push(chalk.red(`${formatNumber(stats.failures)} failed`));
    if (stats.noChanges > 0) parts.push(chalk.gray(`${formatNumber(stats.noChanges)} no-change`));
    if (stats.errors > 0) parts.push(chalk.red(`${formatNumber(stats.errors)} errors`));
    
    const rateStr = total > 0 ? ` (${successColor(pct + '%')} success)` : '';
    console.log(`  ${key}: ${parts.join(', ')}${rateStr}`);
  }
}

/**
 * Get display properties for an exit reason
 */
type ChalkColorFn = (text: string) => string;

export function getExitReasonDisplay(exitReason: string | null): { 
  label: string; 
  icon: string; 
  color: ChalkColorFn 
} {
  switch (exitReason) {
    case 'all_fixed':
    case 'all_resolved':
    case 'audit_passed':
      return { label: 'All issues resolved', icon: '✓', color: chalk.green };
    
    case 'bail_out':
      return { label: 'Bail-out (stalemate)', icon: '⚠', color: chalk.red };
    
    case 'max_iterations':
      return { label: 'Max iterations reached', icon: '⏱', color: chalk.yellow };
    
    case 'no_comments':
      return { label: 'No review comments found', icon: '○', color: chalk.green };
    
    case 'dry_run':
      return { label: 'Dry run completed', icon: '👁', color: chalk.blue };
    
    case 'no_commit_mode':
      return { label: 'Stopped (no-commit mode)', icon: '⏸', color: chalk.yellow };
    
    case 'no_push_mode':
      return { label: 'Stopped (no-push mode)', icon: '⏸', color: chalk.yellow };
    
    case 'committed_locally':
      return { label: 'Committed locally (not pushed)', icon: '📝', color: chalk.blue };
    
    case 'no_changes':
      return { label: 'No changes made', icon: '○', color: chalk.yellow };
    
    default:
      return { label: exitReason || 'Unknown', icon: '?', color: chalk.gray };
  }
}

/**
 * Print final results summary
 * WHY: Profiling info pushes important results off screen. This ensures
 * the most important info (what got fixed) is visible at the end.
 */
export function printFinalSummary(
  stateContext: StateContext | null,
  exitReason: string | null,
  exitDetails: string | null
): void {
  if (!stateContext?.state) return;
  
  // Get counts
  const verifiedFixed = stateContext.state.verifiedFixed || [];
  const dismissedIssues = Dismissed.getDismissedIssues(stateContext);
  
  // Exclude "already-fixed" dismissed issues from the fixed count.
  // WHY: Issues that were already fixed before the tool ran appear in BOTH
  // verifiedFixed (for caching) and dismissedIssues (with category "already-fixed").
  // Counting them in both "fixed" and "dismissed" double-counts and inflates results.
  const alreadyFixedIds = new Set(
    dismissedIssues
      .filter(d => d.category === 'already-fixed')
      .map(d => d.commentId)
  );
  const toolFixedCount = verifiedFixed.filter(id => !alreadyFixedIds.has(id)).length;
  
  console.log(chalk.cyan('\n════════════════════════════════════════════════════════════'));
  console.log(chalk.cyan('                      RESULTS SUMMARY                         '));
  console.log(chalk.cyan('════════════════════════════════════════════════════════════'));
  
  // Exit reason - most important info
  const exitReasonDisplay = getExitReasonDisplay(exitReason);
  console.log(exitReasonDisplay.color(`\n  ${exitReasonDisplay.icon} Exit: ${exitReasonDisplay.label}`));
  if (exitDetails) {
    console.log(chalk.gray(`     ${exitDetails}`));
  }
  
  // Fixed issues (only count issues actually fixed by the tool, not pre-existing fixes)
  if (toolFixedCount > 0) {
    console.log(chalk.green(`\n  ✓ ${formatNumber(toolFixedCount)} issue${toolFixedCount === 1 ? '' : 's'} fixed and verified`));
  }
  
  // Dismissed issues by category
  if (dismissedIssues.length > 0) {
    const byCategory = dismissedIssues.reduce((acc, issue) => {
      acc[issue.category] = (acc[issue.category] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
    
    const categoryParts = Object.entries(byCategory)
      .map(([cat, count]) => `${count} ${cat}`)
      .join(', ');
    
    console.log(chalk.gray(`  ○ ${formatNumber(dismissedIssues.length)} issue${dismissedIssues.length === 1 ? '' : 's'} dismissed (${categoryParts})`));
  }
  
  console.log(chalk.cyan('\n════════════════════════════════════════════════════════════'));
}

/**
 * Print developer handoff prompt for remaining issues.
 * This gives a prompt that can be used with any LLM tool to continue the work.
 */
export function printHandoffPrompt(
  unresolvedIssues: UnresolvedIssue[],
  noHandoffPrompt: boolean
): void {
  if (noHandoffPrompt || unresolvedIssues.length === 0) return;
  
  console.log(chalk.cyan('\n┌─────────────────────────────────────────────────────────────┐'));
  console.log(chalk.cyan('│              DEVELOPER HANDOFF PROMPT                       │'));
  console.log(chalk.cyan('└─────────────────────────────────────────────────────────────┘'));
  console.log(chalk.gray('\nCopy this prompt to continue with a different tool:\n'));
  
  console.log(chalk.white('─'.repeat(60)));
  console.log(chalk.white(`Fix the following ${unresolvedIssues.length} code review issue(s):\n`));
  
  for (let i = 0; i < unresolvedIssues.length; i++) {
    const issue = unresolvedIssues[i];
    console.log(chalk.white(`${i + 1}. File: ${issue.comment.path}${issue.comment.line ? `:${issue.comment.line}` : ''}`));
    // Sanitize comment body for terminal readability — strip HTML, massive URLs, images
    const cleanBody = sanitizeCommentForDisplay(issue.comment.body);
    const issueLines = cleanBody.split('\n');
    console.log(chalk.white(`   Issue: ${issueLines[0]}`));
    for (let j = 1; j < issueLines.length; j++) {
      if (issueLines[j].trim()) {
        console.log(chalk.white(`          ${issueLines[j]}`));
      }
    }
    console.log('');
  }
  
  console.log(chalk.white('For each issue, make the minimum necessary code change to address'));
  console.log(chalk.white('the reviewer\'s concern while maintaining code quality and tests.'));
  console.log(chalk.white('─'.repeat(60)));
  console.log(chalk.gray('\n(Disable with --no-handoff-prompt)'));
}

/**
 * Suggest possible resolutions for an unresolved issue.
 * Prioritizes actionable, pattern-specific suggestions over generic boilerplate.
 */
function suggestResolutions(issue: UnresolvedIssue, stateContext?: StateContext | null): string[] {
  const resolutions: string[] = [];
  const body = issue.comment.body.toLowerCase();
  const path = issue.comment.path;
  const pathLower = path.toLowerCase();

  // --- Pattern 1: File corruption (multiple reviews about same file being broken) ---
  if (body.includes('corrupt') || body.includes('garbled') || body.includes('broken code')
    || body.includes('duplicate') && body.includes('method')
    || body.includes('orphaned') && body.includes('code')
    || body.includes('multiple automated fix attempts')) {
    resolutions.push(`Restore ${path} from the base branch: git show origin/dev:${path} > ${path}`);
    resolutions.push('The file may have been corrupted by previous automated fix attempts — a clean slate is faster than patching');
  }

  // --- Pattern 2: Test writing requests ---
  if (body.includes('test') && (body.includes('coverage') || body.includes('automated') || body.includes('unit'))) {
    resolutions.push('Write tests manually — LLMs struggle to generate working test suites without a running test harness');
    resolutions.push('Start with a single happy-path test, verify it runs, then expand to edge cases');
  }

  // --- Pattern 3: Multi-file consistency (duplication, shared imports) ---
  if (body.includes('duplicat') && (body.includes('import') || body.includes('shared') || body.includes('inline'))) {
    resolutions.push('Fix the shared module first, then update all import sites in a single commit');
  }

  // --- Pattern 4: Transaction / atomicity ---
  if (body.includes('transaction') || body.includes('atomic') || (body.includes('race') && body.includes('condition'))) {
    resolutions.push('Database transactions require understanding the ORM/driver — review the DB layer docs for this project');
    resolutions.push('Consider a compensating-action pattern if true transactions are not available');
  }

  // --- Pattern 5: Dead code / unused variables ---
  if (body.includes('unused') || body.includes('dead code') || body.includes('never referenced')) {
    resolutions.push('Simple deletion — verify no other files import the symbol, then remove it');
  }

  // --- Pattern 6: Security / Redis / cache issues ---
  if (body.includes('redis') || body.includes('cache') && body.includes('unavailable')) {
    resolutions.push('Add an availability check at the entry point (return 503 early) rather than fixing downstream');
  }

  // --- Fallback: content-based ---
  if (resolutions.length === 0) {
    if (body.includes('error') || body.includes('exception')) {
      resolutions.push('Review error handling and add appropriate try-catch or fail-fast logic');
    } else if (body.includes('security') || body.includes('injection')) {
      resolutions.push('Review security implications and add input validation');
    } else {
      resolutions.push('Manually review the code and reviewer comment');
    }
  }

  // One generic fallback at most
  if (resolutions.length < 3) {
    resolutions.push('Break the issue into smaller, incremental changes');
  }

  return resolutions.slice(0, 4);
}

/**
 * Print after action report for remaining issues.
 * Provides analysis of what was attempted and possible resolutions.
 */
export async function printAfterActionReport(
  unresolvedIssues: UnresolvedIssue[],
  comments: ReviewComment[],
  noAfterAction: boolean,
  stateContext: StateContext | null,
  lessonsContext: LessonsContext | null
): Promise<void> {
  if (noAfterAction || unresolvedIssues.length === 0) return;
  
  console.log(chalk.cyan('\n┌─────────────────────────────────────────────────────────────┐'));
  console.log(chalk.cyan('│                 AFTER ACTION REPORT                         │'));
  console.log(chalk.cyan('└─────────────────────────────────────────────────────────────┘'));
  
  
  for (let i = 0; i < unresolvedIssues.length; i++) {
    const issue = unresolvedIssues[i];
    const issueNum = i + 1;
    
    console.log(chalk.yellow(`\n━━━ Issue ${issueNum}/${unresolvedIssues.length}: ${issue.comment.path}:${issue.comment.line || '?'} ━━━`));
    
    // Original issue - sanitized for terminal readability
    console.log(chalk.cyan('\n  📝 Original Issue:'));
    const cleanIssue = sanitizeCommentForDisplay(issue.comment.body);
    for (const line of cleanIssue.split('\n')) {
      console.log(chalk.gray(`     ${line}`));
    }
    
    // Analysis / why it's hard
    // IMPORTANT: The batch verifier determined this issue still exists.
    // If the analysis below suggests the fix "may already be in place,"
    // that's a stale/inconsistent analysis — the verifier's verdict takes precedence.
    console.log(chalk.cyan('\n  🔍 Analysis:'));
    if (issue.explanation) {
      const looksFixedPhrases = ['already.*(?:fixed|applied|in place)', 'fix.*may.*already', 'suggests.*the fix'];
      const contradictsVerifier = looksFixedPhrases.some(p => new RegExp(p, 'i').test(issue.explanation || ''));
      if (contradictsVerifier) {
        console.log(chalk.yellow(`     ⚠ Note: Analysis below suggests fix may be in place, but verifier confirmed issue STILL EXISTS.`));
      }
      console.log(chalk.gray(`     ${issue.explanation}`));
    }
    
    // Check model performance for this file
    const fileModels = stateContext ? Performance.getModelsBySuccessRate(stateContext) : [];
    const relevantAttempts = fileModels.filter(m => m.stats.fixes > 0 || m.stats.failures > 0);
    if (relevantAttempts.length > 0) {
      console.log(chalk.gray(`     Tools attempted: ${relevantAttempts.map(m => m.key.split('/')[0]).join(', ')}`));
    }
    
    // Learnings related to this file
    const fileSpecificLessons = lessonsContext ? LessonsAPI.Retrieve.getLessonsForFiles(lessonsContext, [issue.comment.path]) : [];
    if (fileSpecificLessons.length > 0) {
      console.log(chalk.cyan('\n  📚 Relevant Learnings:'));
      for (const lesson of fileSpecificLessons.slice(0, 3)) {
        console.log(chalk.gray(`     • ${lesson}`));
      }
    }
    
    // Possible resolutions
    console.log(chalk.cyan('\n  💡 Possible Resolutions:'));
    const resolutions = suggestResolutions(issue, stateContext);
    for (const resolution of resolutions) {
      console.log(chalk.gray(`     • ${resolution}`));
    }
  }
  
  // Summary
  console.log(chalk.cyan('\n━━━ Summary ━━━'));
  const fixedCount = comments.filter(c => stateContext ? Verification.isVerified(stateContext, c.id) : false).length;
  const dismissedCount = stateContext ? Dismissed.getDismissedIssues(stateContext).length : 0;
  console.log(chalk.gray(`  Total issues: ${comments.length}`));
  console.log(chalk.green(`  Fixed: ${fixedCount}`));
  console.log(chalk.gray(`  Dismissed: ${dismissedCount}`));
  console.log(chalk.yellow(`  Remaining: ${unresolvedIssues.length}`));
  
  console.log(chalk.gray('\n(Disable with --no-after-action)'));
}

/**
 * Print unresolved issues for dry run mode
 */
export function printUnresolvedIssues(issues: UnresolvedIssue[]): void {
  console.log(chalk.blue('\n=== Unresolved Issues (Dry Run) ===\n'));

  for (let i = 0; i < issues.length; i++) {
    const issue = issues[i];
    console.log(chalk.yellow(`Issue ${i + 1}: ${issue.comment.path}:${issue.comment.line || '?'}`));
    console.log(chalk.gray('Comment:'), sanitizeCommentForDisplay(issue.comment.body).substring(0, 200));
    console.log(chalk.gray('Analysis:'), issue.explanation);
    console.log('');
  }
}
