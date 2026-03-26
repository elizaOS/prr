/**
 * Pill analysis-only: assemble context from logs, run audit LLM, append to pill-output.md and pill-summary.md.
 * No runners, fix, verify, or commit.
 *
 * WHY no import from shared/logger: closeOutputLog() in shared/logger.ts dynamically imports this module
 * to run the pill hook. Importing formatNumber (or anything) from logger would create a circular dependency.
 * User-facing numbers use n.toLocaleString() here (workspace rule allows that when logger is not imported).
 */
import chalk from 'chalk';
import ora from 'ora';
import { appendFileSync } from 'fs';
import { join } from 'path';
import type { PillConfig, ImprovementPlan, Improvement } from './types.js';
import { DEFAULT_PILL_CONTEXT_BUDGET_TOKENS } from './config.js';
import { assembleContext, getContextTokenCounts } from './context.js';
import { LLMClient } from './llm/client.js';
import { AUDIT_SYSTEM_PROMPT } from './llm/prompts.js';
import { extractJsonLenient } from './llm/parse-json.js';
import { truncateHeadAndTailByChars, CHARS_PER_TOKEN } from '../../shared/utils/tokens.js';
import { chunkPlainText } from '../../shared/llm/story-read.js';
import { filterImprovementsByToolRepoScope } from './tool-repo-scope.js';

/** Default hard cap on user message length (chars) per audit HTTP request. Override: PILL_AUDIT_MAX_USER_CHARS.
 * WHY 20k not 42k: Vercel FUNCTION_INVOCATION_TIMEOUT on ElizaCloud with claude-opus + ~44k POST bodies (audit still failed). */
const DEFAULT_AUDIT_USER_MESSAGE_MAX_CHARS = 20_000;
/** Opus / heavy models: smaller payloads finish inside gateway limits. Skipped when PILL_AUDIT_MAX_USER_CHARS is set. */
const SLOW_AUDIT_MODEL_MAX_USER_CHARS = 12_000;
const MIN_AUDIT_USER_MESSAGE_MAX_CHARS = 6_000;
/**
 * Optimistic chars/token when converting PILL_CONTEXT_BUDGET_TOKENS → max user chars (allow more text in budget).
 * MUST NOT be used for chunkPlainText — that uses shared estimateTokens (length / CHARS_PER_TOKEN).
 */
const BUDGET_TO_USER_CHARS_RATIO = 2.7;
const USER_MESSAGE_TOKEN_FRACTION = 0.8;
/** Safety margin for system prompt + JSON overhead (subtracted from calculated cap to avoid 504). */
const REQUEST_OVERHEAD_CHARS = 11_000;
/** Reserve for `[CONTEXT CHUNK i/n]\n\n` so chunk body + prefix ≤ userMessageMaxChars. */
const CHUNK_PREFIX_RESERVE_CHARS = 160;

/**
 * Subdivide chapters whose text exceeds maxChars (e.g. one log line longer than token budget).
 * WHY: chunkPlainText emits a single line as one chapter when that line alone exceeds the token budget; that can still be huge in bytes.
 */
function isSlowAuditModel(model: string): boolean {
  const m = model.toLowerCase();
  if (/opus|claude-3-opus|o3-|o1-pro/.test(m)) return true;
  // gpt-5 family can be slow on gateways; exclude mini/nano-sized ids from the tight cap.
  if (/gpt-5/.test(m) && !/gpt-5-nano|gpt-5-mini|5-nano|5-mini/.test(m)) return true;
  return false;
}

/** Max user chars per audit request (single or per chunk). Env override wins; else slow models get a tighter cap. */
function computeAuditUserMessageMaxChars(
  budgetTokens: number,
  auditModel: string,
  envOverride?: number
): number {
  const fromBudget = Math.floor(budgetTokens * USER_MESSAGE_TOKEN_FRACTION * BUDGET_TO_USER_CHARS_RATIO) - REQUEST_OVERHEAD_CHARS;
  let cap = Math.min(DEFAULT_AUDIT_USER_MESSAGE_MAX_CHARS, fromBudget);
  if (envOverride !== undefined && Number.isFinite(envOverride)) {
    cap = Math.min(Math.max(MIN_AUDIT_USER_MESSAGE_MAX_CHARS, envOverride), 80_000);
  } else if (isSlowAuditModel(auditModel)) {
    cap = Math.min(cap, SLOW_AUDIT_MODEL_MAX_USER_CHARS);
  }
  return Math.max(MIN_AUDIT_USER_MESSAGE_MAX_CHARS, cap);
}

function enforceMaxChunkChars(
  chapters: { label: string; text: string }[],
  maxChars: number
): { label: string; text: string }[] {
  const out: { label: string; text: string }[] = [];
  for (const ch of chapters) {
    if (ch.text.length <= maxChars) {
      out.push(ch);
      continue;
    }
    const sliceCount = Math.ceil(ch.text.length / maxChars);
    for (let p = 0; p < sliceCount; p++) {
      out.push({
        label: `${ch.label} · part ${p + 1}/${sliceCount}`,
        text: ch.text.slice(p * maxChars, (p + 1) * maxChars),
      });
    }
  }
  return out;
}

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
  const obj = extractJsonLenient<{ pitch?: string; summary?: string; improvements?: unknown[] }>(raw);
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

/** Append a minimal "run but no improvements" section so pill-output.md / pill-summary.md are not left empty when user passed --pill. */
function appendNoImprovementsRun(
  targetDir: string,
  meta: PillOutputMeta,
  reason: PillNoImprovementsReason,
  instructionsPathOverride?: string,
  extra?: { filteredCount?: number }
): void {
  const instructionsPath = instructionsPathOverride ?? join(targetDir, 'pill-output.md');
  const summaryPath = join(targetDir, 'pill-summary.md');
  const title = `${meta.date} -- ${meta.source} run analysis`;
  const reasonText =
    reason === 'no_logs'
      ? 'No logs to analyze (output/prompts log empty or missing).'
      : reason === 'no_api_key'
        ? 'No API key configured.'
        : reason === 'zero_improvements_from_llm'
          ? 'LLM returned zero improvements.'
          : reason === 'all_filtered_tool_scope'
            ? `All suggestions were filtered (paths outside this tool repository — e.g. the PR clone).${
                extra?.filteredCount != null
                  ? ` ${extra.filteredCount.toLocaleString()} suggestion(s) omitted.`
                  : ''
              } Set PILL_TOOL_REPO_SCOPE_FILTER=0 to disable filtering and record everything.`
            : 'Audit request failed.';
  const instructionsEntry = [
    '',
    '---',
    '',
    `## ${title}`,
    '',
    '### Summary',
    '',
    `No improvements suggested (${reasonText})`,
    '',
    '---',
  ].join('\n');
  const summaryEntry = [
    '',
    '---',
    '',
    `## ${title}`,
    '',
    `> No improvements (${reasonText})`,
    '',
    '---',
  ].join('\n');
  appendFileSync(instructionsPath, instructionsEntry, 'utf-8');
  appendFileSync(summaryPath, summaryEntry, 'utf-8');
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
  | 'no_api_key'
  | 'api_call_failed'
  | 'zero_improvements_from_llm'
  | 'all_filtered_tool_scope';

export interface PillNoImprovementsResult {
  result: null;
  reason: PillNoImprovementsReason;
  errorMessage?: string;
  /** When reason is all_filtered_tool_scope: how many LLM suggestions were dropped. */
  filteredCount?: number;
}

/**
 * Run the audit LLM and append to pill-output.md / pill-summary.md (or return paths in dry-run).
 * Errors (LLM, parse, write) propagate to the caller. Callers: pill CLI (should see errors) and
 * shared/logger closeOutputLog() hook (wraps in try/catch so pill remains optional and shutdown completes).
 * When no improvements are recorded, returns { result: null, reason } so operators can distinguish no logs / no API key / zero improvements (pill-output.md #1).
 */
export async function runPillAnalysis(config: PillConfig): Promise<
  | { result: PillAnalysisResult; reason?: never }
  | PillNoImprovementsResult
> {
  const spinner = config.verbose ? null : ora();
  const update = (text: string) => {
    if (spinner) spinner.text = text;
  };

  function recordNoImprovements(reason: PillNoImprovementsReason, extra?: { filteredCount?: number }): void {
    if (config.dryRun) return;
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 16).replace('T', ' ');
    const source = (config.logPrefix?.trim()) ? config.logPrefix : 'prr';
    appendNoImprovementsRun(config.targetDir, { date: dateStr, source }, reason, config.instructionsOut, extra);
  }

  // No API key — distinct message so operators know why (pill-output.md #3)
  if (config.llmProvider === 'elizacloud' && !config.elizacloudApiKey?.trim()) {
    if (spinner) spinner.info('Pill: No API key configured (elizacloud). Set ELIZACLOUD_API_KEY in .env.');
    recordNoImprovements('no_api_key');
    return { result: null, reason: 'no_api_key' };
  }
  if (config.llmProvider === 'openai' && !config.openaiApiKey?.trim()) {
    if (spinner) spinner.info('Pill: No API key configured (openai). Set OPENAI_API_KEY in .env.');
    recordNoImprovements('no_api_key');
    return { result: null, reason: 'no_api_key' };
  }
  if (config.llmProvider === 'anthropic' && !config.anthropicApiKey?.trim()) {
    if (spinner) spinner.info('Pill: No API key configured (anthropic). Set ANTHROPIC_API_KEY in .env.');
    recordNoImprovements('no_api_key');
    return { result: null, reason: 'no_api_key' };
  }

  try {
    if (config.verbose) {
      console.log('Provider:', config.llmProvider);
      console.log('Audit model:', config.auditModel);
    } else if (spinner) {
      spinner.start('Assembling context…');
    }

    const llmClient = new LLMClient(config);
    const ctx = await assembleContext(config, llmClient);

    const budgetTokens = config.contextBudgetTokens ?? DEFAULT_PILL_CONTEXT_BUDGET_TOKENS;
    if (ctx.contextTrimmed && spinner) {
      spinner.info(`Context trimmed to fit ${budgetTokens.toLocaleString()} token budget (avoids 504/timeout).`);
    }

    const hasLogs = ctx.outputLog.trim().length > 0 || (ctx.promptsDigest ?? '').trim().length > 0;
    if (!hasLogs) {
      if (spinner) spinner.info('Pill: No logs to analyze (output/prompts log empty or missing for this prefix).');
      recordNoImprovements('no_logs');
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
    } else {
      update('Running audit…');
    }

    // Subtract overhead so total request (user + system + JSON) stays under gateway time/size limits.
    const userMessageMaxChars = computeAuditUserMessageMaxChars(
      budgetTokens,
      config.auditModel,
      config.auditMaxUserChars
    );
    const fullUserMessage = buildAuditUserMessage(ctx);
    
    // Pill chunking: Instead of truncating, chunk large contexts and merge results
    let plan: ImprovementPlan;
    if (fullUserMessage.length > userMessageMaxChars) {
      if (spinner) spinner.info(`Context exceeds ${userMessageMaxChars.toLocaleString()} chars — chunking into multiple audit requests (avoids 504/timeout).`);
      
      // MUST use shared CHARS_PER_TOKEN (4): chunkPlainText uses estimateTokens = ceil(len/4).
      // Previously we divided by 2.7 here, which let each chapter grow to ~74k chars → 504 on ElizaCloud.
      const maxChunkBodyChars = Math.max(4_000, userMessageMaxChars - CHUNK_PREFIX_RESERVE_CHARS);
      const chunkTokenBudget = Math.max(512, Math.floor(maxChunkBodyChars / CHARS_PER_TOKEN));
      let chapters = chunkPlainText(fullUserMessage, chunkTokenBudget);
      chapters = enforceMaxChunkChars(chapters, maxChunkBodyChars);
      
      if (spinner) update(`Running audit (${chapters.length} chunk${chapters.length === 1 ? '' : 's'})…`);
      
      // Send audit request for each chunk and merge results
      const chunkPlans: ImprovementPlan[] = [];
      for (let i = 0; i < chapters.length; i++) {
        if (spinner && chapters.length > 1) {
          update(`Running audit chunk ${i + 1}/${chapters.length}…`);
        }
        const chunkMessage = `[CONTEXT CHUNK ${i + 1}/${chapters.length}]\n\n${chapters[i].text}`;
        const chunkResponse = await llmClient.complete(chunkMessage, AUDIT_SYSTEM_PROMPT, {
          model: config.auditModel,
        });
        const chunkPlan = parseImprovementPlan(chunkResponse.content);
        chunkPlans.push(chunkPlan);
      }
      
      // Merge chunk results: combine improvements, use first non-empty pitch/summary
      const allImprovements: Improvement[] = [];
      let mergedPitch = '';
      let mergedSummary = '';
      for (const chunkPlan of chunkPlans) {
        allImprovements.push(...chunkPlan.improvements);
        if (!mergedPitch && chunkPlan.pitch) mergedPitch = chunkPlan.pitch;
        if (!mergedSummary && chunkPlan.summary) mergedSummary = chunkPlan.summary;
      }
      
      // Deduplicate improvements by file+description (same file with similar description = duplicate)
      const seen = new Map<string, Improvement>();
      for (const imp of allImprovements) {
        const key = `${imp.file}:${imp.description.substring(0, 100)}`;
        if (!seen.has(key) || (imp.severity === 'critical' && seen.get(key)!.severity !== 'critical')) {
          seen.set(key, imp);
        }
      }
      
      plan = {
        pitch: mergedPitch || `Analyzed ${chapters.length} context chunk(s) and found ${seen.size} improvement(s).`,
        summary: mergedSummary || `Merged audit results from ${chapters.length} chunk(s).`,
        improvements: Array.from(seen.values()),
      };
    } else {
      const response = await llmClient.complete(fullUserMessage, AUDIT_SYSTEM_PROMPT, {
        model: config.auditModel,
      });
      plan = parseImprovementPlan(response.content);
      if (response.usage && config.verbose) {
        console.log(chalk.gray(`\nTokens: in=${response.usage.inputTokens} out=${response.usage.outputTokens}`));
      }
    }

    let scopeFilteredTotal = 0;
    if (config.toolRepoScopeFilter) {
      const { kept, dropped } = filterImprovementsByToolRepoScope(plan.improvements);
      scopeFilteredTotal = dropped;
      plan.improvements = kept;
      if (dropped > 0) {
        const scopeMsg = `Scope filter: omitted ${dropped.toLocaleString()} suggestion(s) outside this tool repository (likely the PR clone). Set PILL_TOOL_REPO_SCOPE_FILTER=0 to disable.`;
        if (plan.improvements.length > 0) {
          plan.summary = `${plan.summary}\n\n(${scopeMsg})`;
        }
        if (config.verbose) {
          console.log(chalk.gray(scopeMsg));
        } else if (spinner && plan.improvements.length > 0) {
          spinner.info(`Pill: ${scopeMsg}`);
        }
      }
    }

    if (config.verbose) {
      displayPlan(plan);
    }
    // Note: Token usage logging is only available for single-request audits (not chunked)
    // When chunking, we make multiple requests and don't aggregate token usage

    if (plan.improvements.length === 0) {
      if (scopeFilteredTotal > 0) {
        if (spinner) {
          spinner.info(
            `Pill: All ${scopeFilteredTotal.toLocaleString()} suggestion(s) were outside tool-repo paths; nothing written. Set PILL_TOOL_REPO_SCOPE_FILTER=0 to include clone-target ideas.`,
          );
        }
        recordNoImprovements('all_filtered_tool_scope', { filteredCount: scopeFilteredTotal });
        return { result: null, reason: 'all_filtered_tool_scope', filteredCount: scopeFilteredTotal };
      }
      if (spinner) spinner.succeed('Pill: LLM returned zero improvements (audit ran successfully).');
      recordNoImprovements('zero_improvements_from_llm');
      return { result: null, reason: 'zero_improvements_from_llm' };
    }

    if (spinner) update('Writing results…');

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 16).replace('T', ' ');
    // Use logPrefix so pill labels split-exec, split-plan, story, etc. correctly; default 'prr' when no prefix (main prr logs).
    const source = (config.logPrefix?.trim()) ? config.logPrefix : 'prr';
    const meta: PillOutputMeta = { date: dateStr, source };

    const instructionsPathOverride = config.instructionsOut;
    const { instructionsPath, summaryPath } = config.dryRun
      ? { instructionsPath: join(config.targetDir, 'pill-output.md'), summaryPath: join(config.targetDir, 'pill-summary.md') }
      : appendPillOutput(config.targetDir, plan, meta, instructionsPathOverride);

    if (spinner) spinner.succeed(`${plan.improvements.length.toLocaleString()} improvement(s) recorded`);

    return {
      result: {
        pitch: plan.pitch,
        plan,
        instructionsPath,
        summaryPath,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const is504 = /504|FUNCTION_INVOCATION_TIMEOUT|timeout/i.test(msg);
    if (spinner) {
      if (is504) {
        spinner.fail(
          `Pill audit timed out (504) — request too large or slow. Try: PILL_AUDIT_MAX_USER_CHARS=8000, PILL_CONTEXT_BUDGET_TOKENS=20000, PILL_OUTPUT_LOG_MAX_CHARS=20000, or a lighter PILL_AUDIT_MODEL (e.g. sonnet).`,
        );
      } else {
        spinner.fail(msg);
      }
    }
    recordNoImprovements('api_call_failed');
    // Return instead of throw so callers can log reason (pill-output.md #3)
    return { result: null, reason: 'api_call_failed', errorMessage: msg };
  } finally {
    if (spinner && spinner.isSpinning) spinner.stop();
  }
}
