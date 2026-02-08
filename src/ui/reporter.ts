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
  
  console.log(chalk.cyan('\n════════════════════════════════════════════════════════════'));
  console.log(chalk.cyan('                      RESULTS SUMMARY                         '));
  console.log(chalk.cyan('════════════════════════════════════════════════════════════'));
  
  // Exit reason - most important info
  const exitReasonDisplay = getExitReasonDisplay(exitReason);
  console.log(exitReasonDisplay.color(`\n  ${exitReasonDisplay.icon} Exit: ${exitReasonDisplay.label}`));
  if (exitDetails) {
    console.log(chalk.gray(`     ${exitDetails}`));
  }
  
  // Fixed issues
  if (verifiedFixed.length > 0) {
    console.log(chalk.green(`\n  ✓ ${formatNumber(verifiedFixed.length)} issue${verifiedFixed.length === 1 ? '' : 's'} fixed and verified`));
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
    // Print full issue body - handoff needs complete context to be useful
    const issueLines = issue.comment.body.split('\n');
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
 */
function suggestResolutions(issue: UnresolvedIssue): string[] {
  const resolutions: string[] = [];
  const body = issue.comment.body.toLowerCase();
  const path = issue.comment.path.toLowerCase();
  
  // Generic suggestions based on issue content
  if (body.includes('type') || body.includes('typescript')) {
    resolutions.push('Review TypeScript types and interfaces in the file');
  }
  if (body.includes('test') || body.includes('coverage')) {
    resolutions.push('Add or update tests for the affected code');
  }
  if (body.includes('error') || body.includes('exception') || body.includes('handle')) {
    resolutions.push('Review error handling and edge cases');
  }
  if (body.includes('performance') || body.includes('slow') || body.includes('optimize')) {
    resolutions.push('Profile the code and consider caching or algorithmic improvements');
  }
  if (body.includes('security') || body.includes('injection') || body.includes('sanitize')) {
    resolutions.push('Review security implications and add input validation');
  }
  if (body.includes('refactor') || body.includes('clean') || body.includes('simplify')) {
    resolutions.push('Break down into smaller functions or extract common patterns');
  }
  
  // File-type specific suggestions
  if (path.endsWith('.tsx') || path.endsWith('.jsx')) {
    resolutions.push('Check React component props and state management');
  }
  if (path.includes('test')) {
    resolutions.push('Verify test assertions match expected behavior');
  }
  
  // Always include these
  if (resolutions.length === 0) {
    resolutions.push('Manually review the code and reviewer comment');
  }
  resolutions.push('Try a different LLM model with more context');
  resolutions.push('Break the issue into smaller, incremental changes');
  
  return resolutions.slice(0, 4); // Max 4 suggestions
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
    
    // Original issue - show full text for useful context
    console.log(chalk.cyan('\n  📝 Original Issue:'));
    const issueLines = issue.comment.body.split('\n');
    for (const line of issueLines) {
      console.log(chalk.gray(`     ${line}`));
    }
    
    // Analysis / why it's hard
    console.log(chalk.cyan('\n  🔍 Analysis:'));
    if (issue.explanation) {
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
    const resolutions = suggestResolutions(issue);
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
    console.log(chalk.gray('Comment:'), issue.comment.body.substring(0, 200));
    console.log(chalk.gray('Analysis:'), issue.explanation);
    console.log('');
  }
}
