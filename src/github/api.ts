import { Octokit } from '@octokit/rest';
import { graphql } from '@octokit/graphql';
import type { PRInfo, ReviewThread, ReviewComment } from './types.js';

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

  async getReviewComments(owner: string, repo: string, prNumber: number): Promise<ReviewComment[]> {
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
}
