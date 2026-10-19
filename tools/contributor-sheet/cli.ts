/**
 * CLI for contributor-sheet.
 */

import { Command } from 'commander';
import chalk from 'chalk';

export interface ContributorSheetOptions {
  json: boolean;
  llm: boolean;
  /** Search only; no per-PR REST fetches. */
  titlesOnly: boolean;
  maxLlmPrLines: number;
  /** How many PRs (by newest `updated_at`) get body + conversation fetches. */
  maxDetailPrs: number;
  maxBodyChars: number;
  maxIssueCommentsPerPr: number;
  maxReviewInlinePerPr: number;
  maxReviewSummariesPerPr: number;
  maxCommentChars: number;
  detailConcurrency: number;
  fetchIssueComments: boolean;
  fetchReviewInline: boolean;
  fetchReviewSummaries: boolean;
  maxCatalogHead: number;
  maxCatalogTail: number;
  maxLlmDigestChars: number;
  output?: string;
  verbose: boolean;
}

export interface ContributorSheetParsedArgs {
  repoRaw: string;
  author: string;
  options: ContributorSheetOptions;
}

function parsePositiveInt(raw: unknown, flag: string, min: number, max?: number): number {
  const n = parseInt(String(raw ?? ''), 10);
  if (Number.isNaN(n) || n < min || (max !== undefined && n > max)) {
    console.error(chalk.red('Error:'), `${flag} must be a number ≥ ${min}` + (max !== undefined ? ` and ≤ ${max}` : ''));
    process.exit(1);
  }
  return n;
}

export function createCLI(): Command {
  const program = new Command();
  program
    .name('contributor-sheet')
    .description(
      'List pull requests by a GitHub user in a repo (search API), fetch descriptions and conversation (issue comments, inline reviews, submitted reviews) for a configurable slice, then print heuristics and optional LLM character sheet.'
    )
    .argument('<repo>', 'owner/repo or https://github.com/owner/repo')
    .argument('<username>', 'GitHub login (same as web filter author:username)')
    .option('--json', 'Output JSON (pull request rows + optional details) instead of markdown', false)
    .option('--llm', 'Append an LLM-written sheet (uses PRR_LLM_* / provider env from loadConfig)', false)
    .option(
      '--titles-only',
      'Skip per-PR fetches: titles/dates/outcomes from search only (fast; no descriptions or threads)',
      false
    )
    .option(
      '--max-detail-prs <n>',
      'How many PRs (newest updated_at first) get full description + conversation fetches. Default 120. Use 0 for none.',
      '120'
    )
    .option('--max-body-chars <n>', 'Max characters of PR description body stored per PR. Default 16,000.', '16000')
    .option('--max-issue-comments <n>', 'Max issue/timeline comments per PR. Default 50.', '50')
    .option('--max-review-inline <n>', 'Max inline review line comments per PR. Default 80.', '80')
    .option('--max-review-summaries <n>', 'Max submitted PR review bodies per PR. Default 15.', '15')
    .option('--max-comment-chars <n>', 'Truncate each comment/description chunk. Default 4,000.', '4000')
    .option('--detail-concurrency <n>', 'Parallel PR detail workers. Default 5.', '5')
    .option('--skip-issue-comments', 'Do not fetch issue/timeline comments', false)
    .option('--skip-review-inline', 'Do not fetch inline review comments', false)
    .option('--skip-review-summaries', 'Do not fetch submitted review bodies', false)
    .option(
      '--max-llm-pr-lines <n>',
      'When using --titles-only with --llm: max one-line PR rows in the prompt. Default 400.',
      '400'
    )
    .option(
      '--max-catalog-head <n>',
      'LLM digest: lines at start of chronological catalog when middle is omitted. Default 320.',
      '320'
    )
    .option(
      '--max-catalog-tail <n>',
      'LLM digest: lines at end of chronological catalog when middle is omitted. Default 320.',
      '320'
    )
    .option('--max-llm-digest-chars <n>', 'Hard cap on LLM user digest size (UTF-16 length). Default 110,000.', '110000')
    .option('-o, --output <file>', 'Write result to a file (markdown or JSON per --json)')
    .option('-v, --verbose', 'Verbose debug logging', false);
  return program;
}

export function parseArgs(program: Command): ContributorSheetParsedArgs {
  program.parse();
  const args = program.args as string[];
  const opts = program.opts();
  if (args.length < 2) {
    program.outputHelp();
    process.exit(1);
  }
  const maxLlmPrLines = parsePositiveInt(opts.maxLlmPrLines, '--max-llm-pr-lines', 20);
  const maxDetailPrs = parsePositiveInt(opts.maxDetailPrs, '--max-detail-prs', 0, 1000);
  const maxBodyChars = parsePositiveInt(opts.maxBodyChars, '--max-body-chars', 500);
  const maxIssueCommentsPerPr = parsePositiveInt(opts.maxIssueComments, '--max-issue-comments', 1, 500);
  const maxReviewInlinePerPr = parsePositiveInt(opts.maxReviewInline, '--max-review-inline', 1, 500);
  const maxReviewSummariesPerPr = parsePositiveInt(opts.maxReviewSummaries, '--max-review-summaries', 1, 100);
  const maxCommentChars = parsePositiveInt(opts.maxCommentChars, '--max-comment-chars', 200);
  const detailConcurrency = parsePositiveInt(opts.detailConcurrency, '--detail-concurrency', 1, 32);
  const maxCatalogHead = parsePositiveInt(opts.maxCatalogHead, '--max-catalog-head', 20);
  const maxCatalogTail = parsePositiveInt(opts.maxCatalogTail, '--max-catalog-tail', 20);
  const maxLlmDigestChars = parsePositiveInt(opts.maxLlmDigestChars, '--max-llm-digest-chars', 10_000, 500_000);

  const json = Boolean(opts.json);
  const llm = Boolean(opts.llm);
  if (json && llm) {
    console.error(chalk.red('Error:'), 'Use either --json or --llm, not both.');
    process.exit(1);
  }
  return {
    repoRaw: args[0].trim(),
    author: args[1].trim(),
    options: {
      json,
      llm,
      titlesOnly: Boolean(opts.titlesOnly),
      maxLlmPrLines,
      maxDetailPrs,
      maxBodyChars,
      maxIssueCommentsPerPr,
      maxReviewInlinePerPr,
      maxReviewSummariesPerPr,
      maxCommentChars,
      detailConcurrency,
      fetchIssueComments: !Boolean(opts.skipIssueComments),
      fetchReviewInline: !Boolean(opts.skipReviewInline),
      fetchReviewSummaries: !Boolean(opts.skipReviewSummaries),
      maxCatalogHead,
      maxCatalogTail,
      maxLlmDigestChars,
      output: opts.output ? String(opts.output).trim() : undefined,
      verbose: Boolean(opts.verbose),
    },
  };
}
