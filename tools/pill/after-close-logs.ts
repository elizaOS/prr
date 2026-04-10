/**
 * Run pill analysis after output/prompts logs are closed and flushed.
 * WHY: Lives in tools/pill (not shared/logger) so shared/ does not depend on tools/pill.
 */
import { appendFileSync, existsSync, readFileSync } from 'fs';
import { dirname } from 'path';
import {
  clearPillScheduled,
  getOriginalConsoleForShutdown,
  getOutputLogPath,
  getOutputLogPrefix,
  getPromptLogPath,
  isPillScheduledForAfterClose,
} from '../../shared/logger.js';
import { runPillAnalysis } from './orchestrator.js';
import { tryLoadPillConfig } from './config.js';

/**
 * If --pill was set and logs have content, run pill once. Call after `closeOutputLog()`.
 */
export async function runPillAfterClosedLogs(): Promise<void> {
  const outputLogPath = getOutputLogPath();
  const promptLogPath = getPromptLogPath();

  const outputLogHasContent =
    outputLogPath && existsSync(outputLogPath) && readFileSync(outputLogPath, 'utf-8').trim().length > 0;
  const hasPromptsToAnalyze =
    promptLogPath &&
    existsSync(promptLogPath) &&
    / (PROMPT|RESPONSE|ERROR): /m.test(readFileSync(promptLogPath, 'utf-8'));

  if (!isPillScheduledForAfterClose() || !outputLogPath || (!outputLogHasContent && !hasPromptsToAnalyze)) {
    return;
  }

  clearPillScheduled();
  const { log: origLog, warn: origWarn, error: origError } = getOriginalConsoleForShutdown();

  try {
    const targetDir = dirname(outputLogPath);
    const config = tryLoadPillConfig({ targetDir, logPrefix: getOutputLogPrefix() });
    if (config) {
      appendFileSync(outputLogPath, '\n[Pill] Running analysis on closed logs…\n', 'utf-8');
      const out = await runPillAnalysis(config);
      if (out.result) {
        appendFileSync(outputLogPath, `[Pill] Done. Instructions: ${out.result.instructionsPath}\n`, 'utf-8');
        origLog('\n' + out.result.pitch);
        origLog(`\n  Instructions: ${out.result.instructionsPath}`);
        origLog(`  Summary log:  ${out.result.summaryPath}`);
      } else {
        const reasonLine =
          out.reason === 'api_call_failed' && (out as { errorMessage?: string }).errorMessage
            ? `[Pill] No improvements to record (reason: ${out.reason}: ${(out as { errorMessage?: string }).errorMessage}).\n`
            : `[Pill] No improvements to record (reason: ${out.reason}).\n`;
        appendFileSync(outputLogPath, reasonLine, 'utf-8');
        const fc = (out as { filteredCount?: number }).filteredCount;
        const consoleMsg =
          out.reason === 'no_logs'
            ? 'Pill: No logs to analyze (output/prompts log empty or missing for this prefix).'
            : out.reason === 'no_api_key'
              ? 'Pill: No improvements to record (no API key configured). Set API key in .env.'
              : out.reason === 'zero_improvements_from_llm'
                ? 'Pill: LLM returned zero improvements (audit ran successfully).'
                : out.reason === 'all_filtered_tool_scope'
                  ? `Pill: All suggestions were outside tool-repo paths (${fc != null ? fc.toLocaleString() : '?'} omitted); nothing written. Set PILL_TOOL_REPO_SCOPE_FILTER=0 to include clone-target ideas.`
                  : out.reason === 'api_call_failed' && (out as { errorMessage?: string }).errorMessage
                    ? `Pill: Audit failed: ${(out as { errorMessage?: string }).errorMessage}`
                    : `Pill: No improvements to record (reason: ${out.reason}).`;
        origLog('\n[Pill] ' + consoleMsg);
      }
    } else {
      appendFileSync(outputLogPath, '[Pill] Skipped (no API key or no config in target dir).\n', 'utf-8');
      origLog('\n[Pill] Skipped (no API key or no config in target dir).');
    }
  } catch (err) {
    origError('[Pill] Error:', err);
    try {
      if (outputLogPath) {
        const msg = err instanceof Error ? err.message : String(err);
        appendFileSync(outputLogPath, `[Pill] Error: ${msg}\n`, 'utf-8');
      }
    } catch { /* ignore */ }
  }
}
