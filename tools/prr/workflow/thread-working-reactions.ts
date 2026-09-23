/**
 * Thread working reactions — post 👀 (`eyes`) on **inline** PR review comments while PRR is actively
 * fixing them (REST `reactions.createForPullRequestReviewComment`).
 *
 * **WHY default-on:** Many review bots signal “looking at this” on the thread; PRR does the same during
 * long fix runs so humans see progress on GitHub, not only in `output.log`.
 *
 * **WHY not bundled with `--reply-to-threads`:** Replies are opt-in (token + notification surface); reactions
 * are smaller REST writes with strict throttle/dedupe/disable rules so they can default on safely.
 *
 * **WHY throttle + dedupe + disable:** Large PRs could otherwise POST once per comment per iteration;
 * spacing + per-`databaseId` tracking caps burstiness. Rate limits and hard errors must never block
 * `executeFixIteration` — we backoff once, then stop posting for the run after repeated failure or one hard error.
 */

import type { GitHubAPI } from '../github/api.js';
import type { PRInfo } from '../github/types.js';
import type { CLIOptions } from '../cli.js';
import type { StateContext } from '../state/state-context.js';
import type { UnresolvedIssue } from '../analyzer/types.js';
import { sleep } from './utils.js';
import { debug, warn } from '../../../shared/logger.js';

export interface ThreadWorkingReactionPoster {
  notifyIssuesFocused(issues: UnresolvedIssue[]): Promise<void>;
}

/** Ephemeral run state lives on `StateContext` so batch + single-issue paths share one dedupe set. */
function ensureReactionState(ctx: StateContext) {
  if (!ctx.threadWorkingReactionRunState) {
    ctx.threadWorkingReactionRunState = {
      postedCommentDatabaseIds: new Set<number>(),
      lastPostAtMs: 0,
      disabledForRestOfRun: false,
    };
  }
  return ctx.threadWorkingReactionRunState;
}

/** @internal exported for tests */
export function parseThreadWorkingReactionMinMsFromEnv(): number {
  const raw = process.env.PRR_THREAD_WORKING_REACTION_MIN_MS?.trim();
  if (!raw) return 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 1000;
  return Math.min(Math.floor(n), 60_000);
}

export function createThreadWorkingReactionPoster(
  github: GitHubAPI | undefined,
  prInfo: PRInfo | undefined,
  options: CLIOptions,
  stateContext: StateContext,
  deps?: { hasGithubToken?: boolean }
): ThreadWorkingReactionPoster {
  const minSpacingMs = parseThreadWorkingReactionMinMsFromEnv();
  const hasToken = deps?.hasGithubToken !== false;

  async function notifyIssuesFocused(issues: UnresolvedIssue[]): Promise<void> {
    if (!github || !prInfo || options.dryRun || !options.threadWorkingReactions || !hasToken) {
      return;
    }
    const st = ensureReactionState(stateContext);
    if (st.disabledForRestOfRun) return;

    const ids = [
      ...new Set(
        issues
          .map((i) => i.comment.databaseId)
          .filter((id): id is number => typeof id === 'number' && Number.isFinite(id) && id > 0)
      ),
    ];

    for (const commentDatabaseId of ids) {
      if (st.disabledForRestOfRun) break;
      if (st.postedCommentDatabaseIds.has(commentDatabaseId)) continue;

      const waitMs = st.lastPostAtMs + minSpacingMs - Date.now();
      if (waitMs > 0) await sleep(waitMs);

      let outcome = await github.createPullRequestReviewCommentReaction(
        prInfo.owner,
        prInfo.repo,
        commentDatabaseId,
        'eyes'
      );

      if (outcome === 'rate_limited') {
        await sleep(2000);
        if (st.disabledForRestOfRun) break;
        outcome = await github.createPullRequestReviewCommentReaction(
          prInfo.owner,
          prInfo.repo,
          commentDatabaseId,
          'eyes'
        );
        if (outcome === 'rate_limited' || outcome === 'error') {
          st.disabledForRestOfRun = true;
          warn(
            'Thread working reactions: still rate-limited or error after backoff — disabling further 👀 reactions for this run.'
          );
          debug('Thread working reactions disabled', { commentDatabaseId, outcome });
          break;
        }
      }

      // Hard failure (e.g. 403 integration, 5xx): one warn, disable for the run — avoid N identical errors on huge PRs.
      if (outcome === 'error') {
        st.postedCommentDatabaseIds.add(commentDatabaseId);
        st.lastPostAtMs = Date.now();
        st.disabledForRestOfRun = true;
        warn(
          'Thread working reactions: GitHub API error posting reaction — disabling further 👀 reactions for this run.'
        );
        debug('Thread working reactions disabled', { commentDatabaseId, outcome });
        break;
      }

      if (outcome === 'created' || outcome === 'duplicate_or_validation' || outcome === 'not_found') {
        st.postedCommentDatabaseIds.add(commentDatabaseId);
        st.lastPostAtMs = Date.now();
      }
    }
  }

  return { notifyIssuesFocused };
}
