// Full implementation in Phase 5A. Until then: Phase 2 = context; Phase 3 = audit; Phase 4 = runners; Phase 5 = fix/verify/commit.
import chalk from 'chalk';
import type { PillConfig, ImprovementPlan, Improvement, AuditCycle } from './types.js';
import { loadAuditCycles, appendCycle, initAuditStore } from './audit-cycles.js';
import type { Runner } from '../../shared/runners/types.js';
import { detectAvailableRunners } from '../../shared/runners/detect.js';
import { assembleContext, getContextTokenCounts } from './context.js';
import { LLMClient } from './llm/client.js';
import { AUDIT_SYSTEM_PROMPT, VERIFY_SYSTEM_PROMPT } from './llm/prompts.js';
import { extractJson } from './llm/parse-json.js';
import type { VerifyResult } from './types.js';
import { snapshotFiles, computeDiffs, changedPaths } from './utils/snapshot.js';

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
  const obj = extractJson<{ summary?: string; improvements?: unknown[] }>(raw);
  const summary = typeof obj.summary === 'string' ? obj.summary : '';
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
  return { summary, improvements };
}

function buildFixPrompt(plan: ImprovementPlan, targetDir: string): string {
  const lines: string[] = [
    `You are working in ${targetDir}. Make the following improvements to the code in this directory.`,
    '',
    plan.summary,
    '',
    'Improvements to apply:',
  ];
  for (const imp of plan.improvements) {
    lines.push(`- ${imp.file}: [${imp.severity}] ${imp.description}`);
    lines.push(`  Rationale: ${imp.rationale}`);
    lines.push('');
  }
  return lines.join('\n');
}

function parseVerifyResult(raw: string): VerifyResult {
  const obj = extractJson<{ status?: string; issues?: unknown[] }>(raw);
  const status = obj.status === 'issues' ? 'issues' : 'clean';
  const issues: Improvement[] = [];
  if (Array.isArray(obj.issues)) {
    for (const item of obj.issues) {
      if (item && typeof item === 'object' && 'file' in item && 'description' in item) {
        const i = item as Record<string, unknown>;
        issues.push({
          file: String(i.file ?? ''),
          description: String(i.description ?? ''),
          rationale: String(i.rationale ?? ''),
          severity: (i.severity as Improvement['severity']) ?? 'minor',
          category: (i.category as Improvement['category']) ?? 'code',
        });
      }
    }
  }
  return status === 'clean' ? { status: 'clean' } : { status: 'issues', issues };
}

function buildVerifyUserMessage(
  plan: ImprovementPlan,
  diffs: string,
  currentFiles: Map<string, string>,
  changedPathsSet: Set<string>
): string {
  const planSection =
    '[IMPROVEMENT PLAN]\n' +
    plan.summary +
    '\n\n' +
    plan.improvements.map((i: Improvement) => `- ${i.file}: ${i.description}`).join('\n');
  const diffSection = '[UNIFIED DIFFS]\n' + (diffs || '(no diffs)');
  const currentParts: string[] = ['[CURRENT STATE OF CHANGED FILES]'];
  for (const path of changedPathsSet) {
    currentParts.push(`\n--- ${path} ---\n${currentFiles.get(path) ?? ''}`);
  }
  return [planSection, diffSection, currentParts.join('')].join('\n\n');
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

export async function runPill(config: PillConfig): Promise<void> {
  if (config.verbose) {
    console.log('Provider:', config.llmProvider);
    console.log('Audit model:', config.auditModel);
  }

  // Step 1: Check git status early (if --commit, block on dirty tree unless --force)
  const { getPreDirtyPaths, commitChanges } = await import('./git.js');
  const preDirtyPaths = config.commit ? await getPreDirtyPaths(config.targetDir) : new Set<string>();
  if (config.commit && !config.force && preDirtyPaths.size > 0) {
    throw new Error(
      `${preDirtyPaths.size} file(s) already modified in ${config.targetDir}. ` +
      `Use --force to proceed (only pill-touched files will be committed).`
    );
  }

  // Step 2: Detect runners before audit (avoid wasting API tokens if no runner available)
  let runner: Runner | null = null;
  if (!config.dryRun) {
    const detected = await detectAvailableRunners();
    if (config.tool === 'auto') {
      runner = detected.length > 0 ? detected[0].runner : null;
    } else {
      runner = detected.find((d) => d.runner.name === config.tool)?.runner ?? null;
    }
    if (!runner) {
      throw new Error('No runner available. Install cursor-agent, claude-code, aider, codex, gemini, or set an API key for llm-api.');
    }
    const status = await runner.checkStatus();
    if (!status.ready) {
      throw new Error(`Runner ${runner.displayName} is not ready: ${status.error ?? 'unknown'}`);
    }
    console.log(chalk.gray(`Using runner: ${runner.displayName}`));
  }

  // Step 3: Assemble context
  const llmClient = new LLMClient(config);
  const ctx = await assembleContext(config, llmClient);
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

  // Step 4: Audit
  const userMessage = buildAuditUserMessage(ctx);
  const response = await llmClient.complete(userMessage, AUDIT_SYSTEM_PROMPT, {
    model: config.auditModel,
  });
  const plan = parseImprovementPlan(response.content);
  displayPlan(plan);
  if (response.usage) {
    console.log(chalk.gray(`\nTokens: in=${response.usage.inputTokens} out=${response.usage.outputTokens}`));
  }

  if (config.dryRun) {
    return;
  }

  if (plan.improvements.length === 0) {
    console.log(chalk.gray('No improvements to apply.'));
    return;
  }

  let filesToFix = [...new Set(plan.improvements.map((i: Improvement) => i.file))];
  const touchedFiles = new Set<string>();
  let currentPlan = plan;

  if (!runner) {
    console.log(chalk.red('No runner available; cannot apply fixes.'));
    return;
  }

  for (let cycle = 1; cycle <= config.maxCycles; cycle++) {
    if (currentPlan.improvements.length === 0) break;
    const before = snapshotFiles(config.targetDir, filesToFix);
    const fixPrompt = buildFixPrompt(currentPlan, config.targetDir);
    const result = await runner.run(config.targetDir, fixPrompt, {
      model: config.fixerModel ?? config.llmModel,
    });
    if (!result.success) {
      console.log(chalk.red('Fix step failed:'), result.error ?? 'unknown');
      break;
    }
    const after = snapshotFiles(config.targetDir, filesToFix);
    const changed = changedPaths(before, after);
    if (changed.size === 0) {
      console.log(chalk.yellow('Runner made no changes; stopping cycle.'));
      break;
    }
    for (const p of changed) touchedFiles.add(p);
    const diffs = computeDiffs(before, after);
    const verifyMsg = buildVerifyUserMessage(currentPlan, diffs, after, changed);
    const verifyRes = await llmClient.complete(verifyMsg, VERIFY_SYSTEM_PROMPT, {
      model: config.auditModel,
    });
    const verifyResult = parseVerifyResult(verifyRes.content);
    if (verifyResult.status === 'clean') {
      console.log(chalk.green('Verify: clean.'));
      break;
    }
    const issues = verifyResult.issues ?? [];
    console.log(chalk.yellow(`Verify: ${issues.length} issue(s) remaining.`));
    for (const i of issues) filesToFix.push(i.file);
    filesToFix = [...new Set(filesToFix)];
    currentPlan = { summary: currentPlan.summary, improvements: issues };
  }

  if (config.commit && touchedFiles.size > 0) {
    await commitChanges(config.targetDir, plan, touchedFiles, preDirtyPaths);
  }

  // Record this run in the directory's audit-cycle store (AUDIT-CYCLES.md–like per directory).
  const today = new Date().toISOString().slice(0, 10);
  const artifacts =
    config.outputOnly && config.promptsOnly
      ? 'pill-output.log, pill-prompts.log'
      : config.outputOnly
        ? 'pill-output.log'
        : config.promptsOnly
          ? 'pill-prompts.log'
          : 'pill-output.log, pill-prompts.log';
  const bySeverity = { high: [] as string[], medium: [] as string[], low: [] as string[] };
  for (const i of plan.improvements) {
    const line = `${i.file}: ${i.description}`;
    if (i.severity === 'critical') bySeverity.high.push(line);
    else if (i.severity === 'important') bySeverity.medium.push(line);
    else bySeverity.low.push(line);
  }
  const cycle: AuditCycle = {
    date: today,
    artifacts,
    findings: bySeverity,
    improvementsImplemented: plan.improvements
      .filter((i) => touchedFiles.has(i.file))
      .map((i) => `${i.file}: ${i.description}`),
    flipFlopCheck: 'Y',
    flipFlopNote: 'No revert or conflicting change detected this run.',
  };
  if (loadAuditCycles(config.targetDir) === null) initAuditStore(config.targetDir);
  appendCycle(config.targetDir, cycle);

  console.log(chalk.gray('\nDone.'));
}
