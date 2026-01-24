import { Octokit } from '@octokit/rest';
import { graphql } from '@octokit/graphql';
import type { PRInfo, ReviewThread, ReviewComment, PRStatus } from './types.js';
import { debug } from '../logger.js';

export class GitHubAPI {
  private octokit: Octokit;
  private graphqlWithAuth: typeof graphql;

  constructor(token: string) {
    this.octokit = new Octokit({ auth: token });
    this.graphqlWithAuth = graphql.defaults({
      headers: {
        authorization: `token ${token}`,
      },
    });
    debug('GitHub API client initialized');
  }

  async getPRInfo(owner: string, repo: string, prNumber: number): Promise<PRInfo> {
    debug('Fetching PR info', { owner, repo, prNumber });
    const { data: pr } = await this.octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    const info: PRInfo = {
      owner,
      repo,
      number: prNumber,
      branch: pr.head.ref,
      baseBranch: pr.base.ref,
      headSha: pr.head.sha,
      cloneUrl: pr.head.repo?.clone_url || `https://github.com/${owner}/${repo}.git`,
      mergeable: pr.mergeable,
      mergeableState: pr.mergeable_state,
    };
    debug('PR info fetched', info);
    return info;
  }

  async getPRStatus(owner: string, repo: string, prNumber: number, ref: string): Promise<PRStatus> {
    debug('Fetching PR status/checks', { owner, repo, prNumber, ref });

    // Get all check runs for this ref using pagination
    const allCheckRuns: Array<{ status: string; name: string }> = [];
    for await (const response of this.octokit.paginate.iterator(
      this.octokit.checks.listForRef,
      {
        owner,
        repo,
        ref,
        per_page: 100,
      }
    )) {
      // paginate.iterator returns items directly in response.data for this endpoint
      const runs = (response.data as any).check_runs || response.data;
      if (Array.isArray(runs)) {
        allCheckRuns.push(...runs);
      }
    }

    const inProgressChecks: string[] = [];
    const pendingChecks: string[] = [];
    let completedChecks = 0;

    for (const check of allCheckRuns) {
      if (check.status === 'in_progress') {
        inProgressChecks.push(check.name);
      } else if (check.status === 'queued' || check.status === 'pending') {
        pendingChecks.push(check.name);
      } else if (check.status === 'completed') {
        completedChecks++;
      }
    }

    const totalChecks = allCheckRuns.length;

    // Get combined status
    const { data: status } = await this.octokit.repos.getCombinedStatusForRef({
      owner,
      repo,
      ref,
    });

    // Get requested reviewers (pending review requests)
    const { data: pr } = await this.octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    const pendingReviewers: string[] = [
      ...pr.requested_reviewers?.map(r => r.login) || [],
      ...pr.requested_teams?.map(t => t.name) || [],
    ];

    // Get reviews to check for "in progress" bot reviews
    const { data: reviews } = await this.octokit.pulls.listReviews({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
    });

    // Patterns that indicate a bot is still reviewing
    const inProgressPatterns = [
      /reviewing|analyzing|processing|scanning|checking/i,
      /will (comment|review|analyze)/i,
      /in progress/i,
      /please wait/i,
      /^>/,  // CodeRabbit summary blocks often start with >
    ];

    // Track bots that might still be reviewing
    const botReviewStates = new Map<string, { hasInProgress: boolean; hasCompleted: boolean }>();
    
    for (const review of reviews) {
      const author = review.user?.login || '';
      const isBot = author.includes('[bot]') || author.toLowerCase().includes('bot');
      
      if (isBot) {
        if (!botReviewStates.has(author)) {
          botReviewStates.set(author, { hasInProgress: false, hasCompleted: false });
        }
        
        const state = botReviewStates.get(author)!;
        const body = review.body || '';
        
        // Check if this looks like an "in progress" message
        const looksInProgress = inProgressPatterns.some(p => p.test(body)) && body.length < 500;
        // Check if this looks like a completed review (has substantial content or code comments)
        const looksCompleted = body.length > 500 || review.state === 'CHANGES_REQUESTED' || review.state === 'APPROVED';
        
        if (looksInProgress && !looksCompleted) {
          state.hasInProgress = true;
        }
        if (looksCompleted) {
          state.hasCompleted = true;
        }
      }
    }

    // Bots that have in-progress markers but no completed review
    const activelyReviewingBots = Array.from(botReviewStates.entries())
      .filter(([_, state]) => state.hasInProgress && !state.hasCompleted)
      .map(([author]) => author);

    // Check for 👀 (eyes) reactions from bots on recent comments
    // This indicates "I'm looking at this / working on it"
    const botsWithEyesReaction = new Set<string>();
    
    try {
      // Get PR comments (issue comments on the PR)
      const { data: issueComments } = await this.octokit.issues.listComments({
        owner,
        repo,
        issue_number: prNumber,
        per_page: 30,  // Recent comments only
      });

      // Check reactions on each comment
      for (const comment of issueComments) {
        if (comment.reactions && comment.reactions.eyes && comment.reactions.eyes > 0) {
          // Get who reacted with eyes
          try {
            const { data: reactions } = await this.octokit.reactions.listForIssueComment({
              owner,
              repo,
              comment_id: comment.id,
              content: 'eyes',
              per_page: 10,
            });
            
            for (const reaction of reactions) {
              const user = reaction.user?.login || '';
              if (user.includes('[bot]') || user.toLowerCase().includes('bot')) {
                botsWithEyesReaction.add(user);
              }
            }
          } catch {
            // Reactions API might fail, ignore
          }
        }
      }
    } catch (err) {
      debug('Failed to check comment reactions', err);
    }

    const prStatus: PRStatus = {
      ciState: status.state as PRStatus['ciState'],
      inProgressChecks,
      pendingChecks,
      totalChecks,
      completedChecks,
      pendingReviewers,
      activelyReviewingBots,
      botsWithEyesReaction: Array.from(botsWithEyesReaction),
    };

    debug('PR status fetched', prStatus);
    return prStatus;
  }

  async getReviewThreads(owner: string, repo: string, prNumber: number): Promise<ReviewThread[]> {
    debug('Fetching review threads via GraphQL', { owner, repo, prNumber });
    const query = `
      query($owner: String!, $repo: String!, $pr: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            reviewThreads(first: 100) {
              nodes {
                id
                isResolved
                path
                line
                diffSide
                comments(first: 20) {
                  nodes {
                    id
                    author {
                      login
                    }
                    body
                    createdAt
                  }
                }
              }
            }
          }
        }
      }
    `;

    interface GraphQLResponse {
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: Array<{
              id: string;
              isResolved: boolean;
              path: string;
              line: number | null;
              diffSide: 'LEFT' | 'RIGHT' | null;
              comments: {
                nodes: Array<{
                  id: string;
                  author: { login: string } | null;
                  body: string;
                  createdAt: string;
                }>;
              };
            }>;
          };
        };
      };
    }

    const response = await this.graphqlWithAuth<GraphQLResponse>(query, {
      owner,
      repo,
      pr: prNumber,
    });

    const threadCount = response.repository.pullRequest.reviewThreads.nodes.length;
    debug(`Found ${threadCount} review threads`);

    return response.repository.pullRequest.reviewThreads.nodes.map((thread) => ({
      id: thread.id,
      path: thread.path,
      line: thread.line,
      diffSide: thread.diffSide,
      isResolved: thread.isResolved,
      comments: thread.comments.nodes.map((comment) => ({
        id: comment.id,
        threadId: thread.id,
        author: comment.author?.login || 'unknown',
        body: comment.body,
        path: thread.path,
        line: thread.line,
        diffSide: thread.diffSide,
        createdAt: comment.createdAt,
        isResolved: thread.isResolved,
      })),
    }));
  }

  async getReviewComments(owner: string, repo: string, prNumber: number): Promise<ReviewComment[]> {
    debug('Getting review comments', { owner, repo, prNumber });
    const threads = await this.getReviewThreads(owner, repo, prNumber);
    const reviewComments: ReviewComment[] = [];

    for (const thread of threads) {
      // Get the first comment in each thread (the original review comment)
      const firstComment = thread.comments[0];

      if (firstComment) {
        reviewComments.push({
          id: firstComment.id,
          threadId: thread.id,
          author: firstComment.author,
          body: firstComment.body,
          path: thread.path,
          line: thread.line,
          createdAt: firstComment.createdAt,
        });
      }
    }

    debug(`Extracted ${reviewComments.length} review comments from threads`);
    return reviewComments;
  }

  async getFileContent(owner: string, repo: string, branch: string, path: string): Promise<string | null> {
    try {
      const { data } = await this.octokit.repos.getContent({
        owner,
        repo,
        path,
        ref: branch,
      });

      if ('content' in data && data.type === 'file') {
        return Buffer.from(data.content, 'base64').toString('utf-8');
      }
      return null;
    } catch (error) {
      // File might not exist
      return null;
    }
  }

  /**
   * Post a comment on a PR (issue comment, not review comment).
   */
  async postComment(owner: string, repo: string, prNumber: number, body: string): Promise<void> {
    debug('Posting comment to PR', { owner, repo, prNumber, bodyLength: body.length });
    await this.octokit.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });
    debug('Comment posted successfully');
  }

  /**
   * Check if a bot has ever commented on this PR.
   * Used to detect if CodeRabbit or other review bots are configured.
   */
  async hasBotCommented(owner: string, repo: string, prNumber: number, botNamePattern: string): Promise<boolean> {
    debug('Checking if bot has commented', { owner, repo, prNumber, botNamePattern });
    
    try {
      // Check issue comments
      const { data: issueComments } = await this.octokit.issues.listComments({
        owner,
        repo,
        issue_number: prNumber,
        per_page: 100,
      });
      
      const pattern = new RegExp(botNamePattern, 'i');
      const hasIssueComment = issueComments.some(c => pattern.test(c.user?.login || ''));
      if (hasIssueComment) return true;
      
      // Check review comments
      const { data: reviews } = await this.octokit.pulls.listReviews({
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      });
      
      const hasReviewComment = reviews.some(r => pattern.test(r.user?.login || ''));
      return hasReviewComment;
    } catch (error) {
      debug('Failed to check bot comments', { error });
      return false;
    }
  }

  /**
   * Check if a bot has reviewed the current commit (HEAD).
   * Returns info about the bot's review status.
   */
  async getBotReviewStatus(
    owner: string, 
    repo: string, 
    prNumber: number, 
    botNamePattern: string,
    currentHeadSha: string
  ): Promise<{
    hasReviewed: boolean;
    isCurrentCommit: boolean;
    lastReviewSha?: string;
    lastReviewDate?: string;
  }> {
    debug('Checking bot review status', { owner, repo, prNumber, botNamePattern, currentHeadSha });
    
    const pattern = new RegExp(botNamePattern, 'i');
    
    try {
      // Get all reviews to find bot's latest
      const { data: reviews } = await this.octokit.pulls.listReviews({
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      });
      
      // Find bot's reviews
      const botReviews = reviews.filter(r => pattern.test(r.user?.login || ''));
      
      if (botReviews.length === 0) {
        // Check issue comments as fallback (some bots use issue comments)
        const { data: issueComments } = await this.octokit.issues.listComments({
          owner,
          repo,
          issue_number: prNumber,
          per_page: 100,
        });
        
        const botComments = issueComments.filter(c => pattern.test(c.user?.login || ''));
        
        if (botComments.length === 0) {
          return { hasReviewed: false, isCurrentCommit: false };
        }
        
        // Get latest bot comment
        const latestComment = botComments[botComments.length - 1];
        
        // Check if the comment mentions the current SHA or was made recently
        // CodeRabbit often includes commit SHA in its comments
        const mentionsCurrentSha = latestComment.body?.includes(currentHeadSha.substring(0, 7)) || false;
        
        return {
          hasReviewed: true,
          isCurrentCommit: mentionsCurrentSha,
          lastReviewDate: latestComment.created_at,
        };
      }
      
      // Get latest bot review
      const latestReview = botReviews[botReviews.length - 1];
      
      // Check if review is for current commit
      // Reviews have commit_id field
      const reviewSha = latestReview.commit_id ?? undefined;
      const isCurrentCommit = reviewSha === currentHeadSha;
      
      return {
        hasReviewed: true,
        isCurrentCommit,
        lastReviewSha: reviewSha,
        lastReviewDate: latestReview.submitted_at ?? undefined,
      };
    } catch (error) {
      debug('Failed to get bot review status', { error });
      return { hasReviewed: false, isCurrentCommit: false };
    }
  }

  /**
   * Check CodeRabbit's review mode.
   * 
   * WHY multiple detection methods:
   * 1. PR comments - Most reliable. CodeRabbit posts "Review skipped - Auto reviews 
   *    are disabled" when in manual mode.
   * 2. .coderabbit.yaml - Config file may specify auto_review: false
   * 3. Default to unknown if neither found
   * 
   * Returns: 'auto' | 'manual' | 'unknown'
   */
  async getCodeRabbitMode(owner: string, repo: string, branch: string, prNumber?: number): Promise<'auto' | 'manual' | 'unknown'> {
    debug('Checking CodeRabbit mode', { owner, repo, branch, prNumber });
    
    // Method 1: Check PR comments for "Review skipped" message
    // WHY: This is the most reliable indicator - CodeRabbit explicitly says it skipped
    if (prNumber) {
      try {
        const comments = await this.octokit.rest.issues.listComments({
          owner,
          repo,
          issue_number: prNumber,
          per_page: 100,
        });
        
        for (const comment of comments.data) {
          const isCodeRabbit = comment.user?.login?.toLowerCase().includes('coderabbit') ||
                              comment.user?.login?.toLowerCase() === 'coderabbitai';
          if (!isCodeRabbit) continue;
          
          // Check for the "Review skipped" message that indicates manual mode
          if (comment.body?.includes('Review skipped') && 
              comment.body?.includes('Auto reviews are disabled')) {
            debug('Found "Review skipped" message - manual mode confirmed');
            return 'manual';
          }
          
          // If we find an actual review (not skipped), it's likely auto mode
          if (comment.body?.includes('## Summary') || 
              comment.body?.includes('## Walkthrough')) {
            debug('Found actual review - auto mode confirmed');
            return 'auto';
          }
        }
      } catch (e) {
        debug('Failed to check PR comments for CodeRabbit mode', { error: e });
      }
    }
    
    // Method 2: Try to read .coderabbit.yaml from repo
    const configContent = await this.getFileContent(owner, repo, branch, '.coderabbit.yaml');
    
    if (configContent) {
      debug('Found .coderabbit.yaml', { length: configContent.length });
      
      // Check for explicit auto_review: false (manual mode)
      if (/auto_review:\s*false/i.test(configContent)) {
        debug('CodeRabbit is in manual mode (auto_review: false)');
        return 'manual';
      }
      
      // Check for auto_review: true (auto mode)
      if (/auto_review:\s*true/i.test(configContent)) {
        debug('CodeRabbit is in auto mode (auto_review: true)');
        return 'auto';
      }
      
      // Check for request_changes_workflow which often indicates manual mode
      if (/request_changes_workflow:\s*true/i.test(configContent)) {
        debug('CodeRabbit has request_changes_workflow - likely manual');
        return 'manual';
      }
      
      // Config exists but doesn't specify - assume auto
      debug('CodeRabbit config exists but mode not explicit - assuming auto');
      return 'auto';
    }
    
    debug('No .coderabbit.yaml found and no definitive PR comments');
    return 'unknown';
  }

  /**
   * Trigger CodeRabbit review if needed.
   * - Detects if CodeRabbit is configured for this repo
   * - Checks if it has already reviewed the current commit
   * - Checks if it's in manual mode (needs trigger) vs auto mode
   * - Only triggers if needed
   * 
   * Returns: { triggered: boolean, mode: string, reason: string, reviewStatus: ... }
   */
  async triggerCodeRabbitIfNeeded(
    owner: string, 
    repo: string, 
    prNumber: number,
    branch: string,
    currentHeadSha: string
  ): Promise<{ 
    triggered: boolean; 
    mode: string; 
    reason: string;
    reviewedCurrentCommit: boolean;
  }> {
    debug('Checking if CodeRabbit trigger needed', { owner, repo, prNumber, currentHeadSha });
    
    // Check CodeRabbit's current review status
    const reviewStatus = await this.getBotReviewStatus(owner, repo, prNumber, 'coderabbit', currentHeadSha);
    
    if (!reviewStatus.hasReviewed) {
      return { 
        triggered: false, 
        mode: 'none', 
        reason: 'CodeRabbit not detected on this PR',
        reviewedCurrentCommit: false,
      };
    }
    
    // If CodeRabbit has already reviewed the current commit, no need to trigger
    if (reviewStatus.isCurrentCommit) {
      return {
        triggered: false,
        mode: 'up-to-date',
        reason: `CodeRabbit already reviewed current commit (${currentHeadSha.substring(0, 7)})`,
        reviewedCurrentCommit: true,
      };
    }
    
    // CodeRabbit exists but hasn't reviewed current commit
    // Check the mode from config and PR comments
    const mode = await this.getCodeRabbitMode(owner, repo, branch, prNumber);
    
    if (mode === 'auto') {
      // Auto mode - CodeRabbit should pick up changes automatically
      // But we can still check if it's been a while
      return { 
        triggered: false, 
        mode: 'auto', 
        reason: `CodeRabbit (auto mode) reviewing older commit (${reviewStatus.lastReviewSha?.substring(0, 7) || '?'}) - should auto-update`,
        reviewedCurrentCommit: false,
      };
    }
    
    // Manual mode or unknown - trigger it for the new commit
    debug('Triggering CodeRabbit review for new commit', { mode, currentHeadSha });
    await this.postComment(owner, repo, prNumber, '@coderabbitai review');
    
    return { 
      triggered: true, 
      mode: mode === 'manual' ? 'manual' : 'unknown',
      reason: mode === 'manual' 
        ? `CodeRabbit (manual mode) - triggered review for new commit (${currentHeadSha.substring(0, 7)})`
        : `CodeRabbit needs trigger for new commit (${currentHeadSha.substring(0, 7)})`,
      reviewedCurrentCommit: false,
    };
  }
}
