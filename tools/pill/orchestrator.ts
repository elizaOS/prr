/**
 * Pill analysis-only: assemble context from logs, run audit LLM, append to pill-output.md and pill-summary.md.
 * No runners, fix, verify, or commit.
 *
 * WHY no import from shared/logger: closeOutputLog() in shared/logger.ts dynamically imports this module
 * to run the pill hook. Importing formatNumber (or anything) from logger would create a circular dependency.
 * User-facing numbers use n.toLocaleString() here (workspace rule allows that when logger is not imported).
 */
import chalk from 'chalk';
import { appendFileSync } from 'fs';
import { join } from 'path';
import type { PillConfig, ImprovementPlan, Improvement } from './types.js';
import { assembleContext, getContextTokenCounts } from './context.js';
import { LLMClient } from './llm/client.js';
import { AUDIT_SYSTEM_PROMPT } from './llm/prompts.js';
import { extractJson } from './llm/parse-json.js';

function buildAuditUserMessage(ctx: {
  docs: string;
  sourceFiles: string;
  directoryTree: string;
  outputLog: string;
  promptsDigest?: string;
}): string {
  const parts = [
    '[DOCS]\n' + ctx.docs,
    '[DIRECTORY TREE]\n' + ctx.directoryTree,
    '[SOURCE CODE]\n' + ctx.sourceFiles,
    '[OUTPUT LOG]\n' + ctx.outputLog,
    '[PROMPTS DIGEST]\n' + (ctx.promptsDigest ?? '(none)'),
  ];
  return parts.join('\n\n');
}

function parseImprovementPlan(raw: string): ImprovementPlan {
  const obj = extractJson<{ pitch?: string; summary?: string; improvements?: unknown[] }>(raw);
  const summary = typeof obj.summary === 'string' ? obj.summary : '';
  const pitch =
    typeof obj.pitch === 'string' ? obj.pitch : typeof obj.summary === 'string' ? obj.summary : '';
  const improvements: Improvement[] = [];
  if (Array.isArray(obj.improvements)) {
    for (const item of obj.improvements) {
      if (item && typeof item === 'object' && 'file' in item && 'description' in item) {
        const i = item as Record<string, unknown>;
        improvements.push({
          file: String(i.file ?? ''),
          description: String(i.description ?? ''),
          rationale: String(i.rationale ?? ''),
          severity: (i.severity as Improvement['severity']) ?? 'minor',
          category: (i.category as Improvement['category']) ?? 'code',
        });
      }
    }
  }
  return { pitch, summary, improvements };
}

function displayPlan(plan: ImprovementPlan): void {
  console.log(chalk.bold('\nImprovement plan'));
  console.log(chalk.gray(plan.summary));
  if (plan.improvements.length === 0) {
    console.log(chalk.gray('No improvements suggested.'));
    return;
  }
  const severityColor = (s: Improvement['severity']) =>
    s === 'critical' ? chalk.red : s === 'important' ? chalk.yellow : chalk.gray;
  for (let i = 0; i < plan.improvements.length; i++) {
    const imp: Improvement = plan.improvements[i];
    console.log(chalk.cyan(`\n${i + 1}. ${imp.file}`));
    console.log(severityColor(imp.severity)(`   [${imp.severity}] ${imp.category}`));
    console.log(chalk.white(`   ${imp.description}`));
    console.log(chalk.gray(`   Rationale: ${imp.rationale}`));
  }
}

/** GitHub-style heading slug: lowercase, alphanumeric/hyphens/spaces only, spaces to single hyphen. */
function headingSlug(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return s || 'section';
}

export interface PillOutputMeta {
  date: string;
  source: string;
}

function formatInstructionsEntry(plan: ImprovementPlan, meta: PillOutputMeta): string {
  const title = `${meta.date} -- ${meta.source} run analysis`;
  const lines: string[] = ['', '---', '', `## ${title}`, '', '### Summary', '', plan.summary, ''];
  if (plan.improvements.length > 0) {
    lines.push('### Improvements', '');
    plan.improvements.forEach((imp, i) => {
      lines.push(`#### ${i + 1}. \`${imp.file}\` [${imp.severity} / ${imp.category}]`);
      lines.push('**Description:** ' + imp.description);
      lines.push('**Rationale:** ' + imp.rationale);
      lines.push('');
    });
  }
  lines.push('---');
  return lines.join('\n');
}

function formatSummaryEntry(
  plan: ImprovementPlan,
  meta: PillOutputMeta,
  instructionsAnchor: string
): string {
  const title = `${meta.date} -- ${meta.source} run analysis`;
  const critical = plan.improvements.filter((i) => i.severity === 'critical').length;
  const important = plan.improvements.filter((i) => i.severity === 'important').length;
  const minor = plan.improvements.filter((i) => i.severity === 'minor').length;
  // User-facing counts: use toLocaleString (no logger import — avoids circular dependency with shared/logger).
  const countLine = `${plan.improvements.length.toLocaleString()} improvement(s) (${critical.toLocaleString()} critical, ${important.toLocaleString()} important, ${minor.toLocaleString()} minor)`;
  const lines: string[] = [
    '',
    '---',
    '',
    `## ${title}`,
    '',
    `> ${countLine}`,
    `> Details: [pill-output.md](${instructionsAnchor})`,
    '',
    plan.pitch || plan.summary,
    '',
    '---',
  ];
  return lines.join('\n');
}

export interface AppendPillOutputResult {
  instructionsPath: string;
  summaryPath: string;
}

function appendPillOutput(
  targetDir: string,
  plan: ImprovementPlan,
  meta: PillOutputMeta,
  instructionsPathOverride?: string
): AppendPillOutputResult {
  const instructionsPath = instructionsPathOverride ?? join(targetDir, 'pill-output.md');
  const summaryPath = join(targetDir, 'pill-summary.md');
  const title = `${meta.date} -- ${meta.source} run analysis`;
  const slug = headingSlug(title);
  const instructionsAnchor = `pill-output.md#${slug}`;

  const instructionsEntry = formatInstructionsEntry(plan, meta);
  const summaryEntry = formatSummaryEntry(plan, meta, instructionsAnchor);

  appendFileSync(instructionsPath, instructionsEntry, 'utf-8');
  appendFileSync(summaryPath, summaryEntry, 'utf-8');

  return { instructionsPath, summaryPath };
}

export interface PillAnalysisResult {
  pitch: string;
  plan: ImprovementPlan;
  instructionsPath: string;
  summaryPath: string;
}

/** Reason when runPillAnalysis returns no improvements (so callers can log the specific cause). */
export type PillNoImprovementsReason =
  | 'no_logs'
  | 'zero_improvements_from_llm';

/**
 * Run the audit LLM and append to pill-output.md / pill-summary.md (or return paths in dry-run).
 * Errors (LLM, parse, write) propagate to the caller. Callers: pill CLI (should see errors) and
 * shared/logger closeOutputLog() hook (wraps in try/catch so pill remains optional and shutdown completes).
 * When no improvements are recorded, returns { result: null, reason } so operators can distinguish no logs / no API key / zero improvements (pill-output.md #1).
 */
export async function runPillAnalysis(config: PillConfig): Promise<
  | { result: PillAnalysisResult; reason?: never }
  | { result: null; reason: PillNoImprovementsReason }
> {
  if (config.verbose) {
    console.log('Provider:', config.llmProvider);
    console.log('Audit model:', config.auditModel);
  }

  const llmClient = new LLMClient(config);
  const ctx = await assembleContext(config, llmClient);

  const hasLogs = ctx.outputLog.trim().length > 0 || (ctx.promptsDigest ?? '').trim().length > 0;
  if (!hasLogs) {
    return { result: null, reason: 'no_logs' };
  }

  const counts = getContextTokenCounts(ctx);
  if (config.verbose) {
    console.log('Context token counts:');
    console.log('  docs:', counts.docs);
    console.log('  sourceFiles:', counts.sourceFiles);
    console.log('  directoryTree:', counts.directoryTree);
    console.log('  outputLog:', counts.outputLog);
    console.log('  promptsDigest:', counts.promptsDigest);
    const total =
      counts.docs + counts.sourceFiles + counts.directoryTree + counts.outputLog + counts.promptsDigest;
    console.log('  total:', total);
  }

  const userMessage = buildAuditUserMessage(ctx);
  const response = await llmClient.complete(userMessage, AUDIT_SYSTEM_PROMPT, {
    model: config.auditModel,
  });
  const plan = parseImprovementPlan(response.content);

  if (config.verbose) {
    displayPlan(plan);
  }
  if (response.usage) {
    console.log(chalk.gray(`\nTokens: in=${response.usage.inputTokens} out=${response.usage.outputTokens}`));
  }

  if (plan.improvements.length === 0) {
    return { result: null, reason: 'zero_improvements_from_llm' };
  }

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 16).replace('T', ' ');
  const source = config.logPrefix === 'story' ? 'story' : config.logPrefix === 'pill' ? 'pill' : 'prr';
  const meta: PillOutputMeta = { date: dateStr, source };

  const instructionsPathOverride = config.instructionsOut;
  const { instructionsPath, summaryPath } = config.dryRun
    ? { instructionsPath: join(config.targetDir, 'pill-output.md'), summaryPath: join(config.targetDir, 'pill-summary.md') }
    : appendPillOutput(config.targetDir, plan, meta, instructionsPathOverride);

  return {
    result: {
      pitch: plan.pitch,
      plan,
      instructionsPath,
      summaryPath,
    },
  };
}
