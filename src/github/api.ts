import { Octokit } from '@octokit/rest';
import { graphql } from '@octokit/graphql';
import type { PRInfo, ReviewThread, BotComment } from './types.js';

export class GitHubAPI {
  private octokit: Octokit;
  private graphqlWithAuth: typeof graphql;
  private botUsers: string[];

  constructor(token: string, botUsers: string[] = ['copilot']) {
    this.octokit = new Octokit({ auth: token });
    this.graphqlWithAuth = graphql.defaults({
      headers: {
        authorization: `token ${token}`,
      },
    });
    this.botUsers = botUsers.map((u) => u.toLowerCase());
  }

  private isBotUser(username: string): boolean {
    const lower = username.toLowerCase();
    return this.botUsers.some((bot) => lower === bot || lower.includes(bot));
  }

  async getPRInfo(owner: string, repo: string, prNumber: number): Promise<PRInfo> {
    const { data: pr } = await this.octokit.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
    });

    return {
      owner,
      repo,
      number: prNumber,
      branch: pr.head.ref,
      cloneUrl: pr.head.repo?.clone_url || `https://github.com/${owner}/${repo}.git`,
    };
  }

  async getReviewThreads(owner: string, repo: string, prNumber: number): Promise<ReviewThread[]> {
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

  async getBotComments(owner: string, repo: string, prNumber: number): Promise<BotComment[]> {
    const threads = await this.getReviewThreads(owner, repo, prNumber);
    const botComments: BotComment[] = [];

    for (const thread of threads) {
      // Find comments from any configured bot in this thread
      const botComment = thread.comments.find((c) => this.isBotUser(c.author));

      if (botComment) {
        botComments.push({
          id: botComment.id,
          threadId: thread.id,
          author: botComment.author,
          body: botComment.body,
          path: thread.path,
          line: thread.line,
          createdAt: botComment.createdAt,
        });
      }
    }

    return botComments;
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
}
