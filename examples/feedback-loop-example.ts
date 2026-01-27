/**
 * Example: Using Dismissed Issues for Generator-Judge Feedback Loop
 *
 * This shows how to programmatically analyze dismissed issues to improve
 * the issue generator and create a dialog between generator and judge.
 */

import { readFile } from 'fs/promises';
import { join } from 'path';

interface DismissedIssue {
  commentId: string;
  reason: string;
  dismissedAt: string;
  dismissedAtIteration: number;
  category: 'already-fixed' | 'not-an-issue' | 'file-unchanged' | 'false-positive' | 'duplicate';
  filePath: string;
  line: number | null;
  commentBody: string;
}

interface ResolverState {
  dismissedIssues?: DismissedIssue[];
  // ... other state fields
}

/**
 * Load dismissed issues from state file
 */
async function loadDismissedIssues(workdir: string): Promise<DismissedIssue[]> {
  const statePath = join(workdir, '.pr-resolver-state.json');
  const content = await readFile(statePath, 'utf-8');
  const state: ResolverState = JSON.parse(content);
  return state.dismissedIssues || [];
}

/**
 * Analyze dismissal patterns to provide feedback to generator
 */
function analyzePatterns(dismissed: DismissedIssue[]): {
  patterns: string[];
  recommendations: string[];
  stats: Record<string, number>;
} {
  const patterns: string[] = [];
  const recommendations: string[] = [];
  const stats: Record<string, number> = {};

  // Count by category
  for (const issue of dismissed) {
    stats[issue.category] = (stats[issue.category] || 0) + 1;
  }

  // Analyze "already-fixed" issues
  const alreadyFixed = dismissed.filter(i => i.category === 'already-fixed');
  if (alreadyFixed.length > 0) {
    patterns.push(`${alreadyFixed.length} issues were flagged as needing fixes that already exist`);

    // Look for common reasons
    const nullCheckReasons = alreadyFixed.filter(i =>
      i.reason.toLowerCase().includes('null check') ||
      i.reason.toLowerCase().includes('guard')
    );

    if (nullCheckReasons.length > 0) {
      patterns.push(`  → ${nullCheckReasons.length} issues missed existing null checks/guards`);
      recommendations.push('Improve detection of early return guards and defensive checks');
    }

    const typeSystemReasons = alreadyFixed.filter(i =>
      i.reason.toLowerCase().includes('typescript') ||
      i.reason.toLowerCase().includes('type') ||
      i.reason.toLowerCase().includes('never be null')
    );

    if (typeSystemReasons.length > 0) {
      patterns.push(`  → ${typeSystemReasons.length} issues ignored by type system guarantees`);
      recommendations.push('Analyze TypeScript types to avoid flagging impossible scenarios');
    }
  }

  // Analyze "file-unchanged" issues
  const fileUnchanged = dismissed.filter(i => i.category === 'file-unchanged');
  if (fileUnchanged.length > 0) {
    patterns.push(`${fileUnchanged.length} issues in files that weren't modified`);
    recommendations.push('Consider analyzing file change likelihood before generating issues');
  }

  // Analyze "false-positive" issues
  const falsePositives = dismissed.filter(i => i.category === 'false-positive');
  if (falsePositives.length > 0) {
    patterns.push(`${falsePositives.length} false positives detected`);
    recommendations.push('Review false positive patterns and adjust detection heuristics');
  }

  return { patterns, recommendations, stats };
}

/**
 * Generate feedback message for the generator
 */
function generateFeedbackMessage(dismissed: DismissedIssue[]): string {
  if (dismissed.length === 0) {
    return '✅ All generated issues were valid! No false positives detected.';
  }

  const analysis = analyzePatterns(dismissed);
  const lines: string[] = [];

  lines.push(`\n📊 GENERATOR FEEDBACK REPORT`);
  lines.push(`════════════════════════════\n`);

  // Stats summary
  lines.push(`Total dismissed: ${dismissed.length}`);
  for (const [category, count] of Object.entries(analysis.stats)) {
    lines.push(`  • ${category}: ${count}`);
  }

  // Patterns detected
  if (analysis.patterns.length > 0) {
    lines.push(`\n🔍 PATTERNS DETECTED:`);
    for (const pattern of analysis.patterns) {
      lines.push(pattern);
    }
  }

  // Recommendations
  if (analysis.recommendations.length > 0) {
    lines.push(`\n💡 RECOMMENDATIONS FOR GENERATOR:`);
    for (let i = 0; i < analysis.recommendations.length; i++) {
      lines.push(`${i + 1}. ${analysis.recommendations[i]}`);
    }
  }

  // Specific examples
  lines.push(`\n📝 EXAMPLE DISMISSALS:\n`);
  const examples = dismissed.slice(0, 3); // Show first 3
  for (const issue of examples) {
    lines.push(`Category: ${issue.category}`);
    lines.push(`Location: ${issue.filePath}:${issue.line || '?'}`);
    lines.push(`Generated comment: "${issue.commentBody}"`);
    lines.push(`Judge's reason: "${issue.reason}"`);
    lines.push(``);
  }

  return lines.join('\n');
}

/**
 * Generate specific learning points for the generator's prompt
 */
function generateLearningPoints(dismissed: DismissedIssue[]): string[] {
  const learnings: string[] = [];

  // Analyze reasons for common keywords
  const reasonTexts = dismissed.map(i => i.reason.toLowerCase()).join(' ');

  if (reasonTexts.includes('null check') || reasonTexts.includes('guard clause')) {
    learnings.push('Check for existing early return guards (e.g., `if (x === null) return;`)');
  }

  if (reasonTexts.includes('typescript') || reasonTexts.includes('type system')) {
    learnings.push('Consider TypeScript type system guarantees before flagging null/undefined issues');
  }

  if (reasonTexts.includes('already implements') || reasonTexts.includes('already has')) {
    learnings.push('Search for existing implementations before suggesting new ones');
  }

  // Check comment patterns
  const commentPatterns = dismissed.map(i => i.commentBody.toLowerCase());

  const nullSafetyComments = commentPatterns.filter(c =>
    c.includes('null') || c.includes('undefined') || c.includes('check')
  ).length;

  if (nullSafetyComments > dismissed.length * 0.3) {
    learnings.push('Null/undefined checks are frequently already present - increase scrutiny for these');
  }

  return learnings;
}

/**
 * Create a structured feedback object for the generator
 */
function createFeedbackForGenerator(dismissed: DismissedIssue[]): {
  timestamp: string;
  dismissalRate: number;
  byCategory: Record<string, number>;
  learningPoints: string[];
  examples: Array<{
    generated: string;
    judgeResponse: string;
    category: string;
  }>;
} {
  const analysis = analyzePatterns(dismissed);
  const learningPoints = generateLearningPoints(dismissed);

  return {
    timestamp: new Date().toISOString(),
    dismissalRate: dismissed.length, // Could be a percentage if we track total issues
    byCategory: analysis.stats,
    learningPoints,
    examples: dismissed.slice(0, 5).map(issue => ({
      generated: issue.commentBody,
      judgeResponse: issue.reason,
      category: issue.category,
    })),
  };
}

// Example usage
async function main() {
  const workdir = process.argv[2] || '.';

  try {
    const dismissed = await loadDismissedIssues(workdir);

    // Print feedback report
    console.log(generateFeedbackMessage(dismissed));

    // Generate structured feedback for generator
    const feedback = createFeedbackForGenerator(dismissed);

    console.log('\n📤 STRUCTURED FEEDBACK FOR GENERATOR:');
    console.log(JSON.stringify(feedback, null, 2));

    // These learning points can be added to the generator's prompt
    if (feedback.learningPoints.length > 0) {
      console.log('\n📚 ADD TO GENERATOR PROMPT:');
      console.log('Lessons learned from previous false positives:');
      for (const point of feedback.learningPoints) {
        console.log(`  - ${point}`);
      }
    }
  } catch (error) {
    console.error('Error loading dismissed issues:', error);
  }
}

// Run if executed directly
if (require.main === module) {
  main();
}

export {
  loadDismissedIssues,
  analyzePatterns,
  generateFeedbackMessage,
  generateLearningPoints,
  createFeedbackForGenerator,
};
