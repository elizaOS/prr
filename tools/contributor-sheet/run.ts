/**
 * Orchestrate fetch → optional per-PR depth → heuristics → optional LLM character sheet.
 */

import chalk from 'chalk';
import ora from 'ora';
import { writeFileSync } from 'fs';
import { Octokit } from '@octokit/rest';
import type { Config } from '../../shared/config.js';
import { debug, formatNumber } from '../../shared/logger.js';
import { LLMClient } from '../prr/llm/client.js';
import { fetchAuthorPrs } from './fetch-prs.js';
import { enrichPrRowsWithConversations, type EnrichOptions } from './fetch-pr-details.js';
import { buildHeuristicSheet, buildPrListForLlm } from './heuristics.js';
import { buildRichLlmDigest } from './build-llm-digest.js';
import type { ContributorSheetOptions } from './cli.js';

const LLM_SYSTEM = `You are a careful engineering manager writing an internal **contributor character sheet** from GitHub data: PR titles, dates, merge outcomes, **descriptions**, and **conversation excerpts** (issue/timeline comments, inline review comments, submitted review bodies).

You do **not** see full diffs, CI logs, or all nested review thread replies.

Rules:
- Separate **evidence** (direct quotes / counts / stated intent in descriptions) from **guess** (inferred habits).
- **Mistakes / friction:** cite specific PR numbers when you claim a pattern (e.g. pushback in comments, follow-up PRs, closed-unmerged).
- **Repeats:** same theme across PRs, similar wording, or explicit references in bodies/comments.
- Be fair and concise. Markdown with the exact section headings below.
- Do not invent PR numbers or events not present in the digest. If the digest omits middle PRs, say so.`;

function buildLlmUserPromptThin(owner: string, repo: string, author: string, prTable: string): string {
  return `Repository: ${owner}/${repo}
GitHub login (PR author): ${author}

Below is a tab-separated table of PRs (oldest → newest within the sample). Columns: number, created date (YYYY-MM-DD), outcome (merged | open | closed_unmerged), title.

${prTable}

Write a **character sheet** using exactly these headings:

## Summary
2–4 sentences.

## Capabilities (evidence vs guess)
What technical areas they *likely* touch; mark guesses.

## What they seem to prefer
Themes (fixes vs features, areas of codebase if visible from titles only).

## Mistakes / friction (only if supported)
Or state unknown / not visible from titles.

## Repeats / iterations
Duplicate themes, follow-up PRs, or unknown.

## What this sheet cannot see
Short bullet list (diffs, CI, full review thread UI, etc.).`;
}

function buildLlmUserPromptRich(owner: string, repo: string, author: string, digest: string): string {
  return `${digest}

---

You are analyzing **${author}** as the **PR author** in **${owner}/${repo}**.

Write a **character sheet** using exactly these headings:

## Summary
2–5 sentences; mention what data you had (catalog + thread depth).

## Capabilities (evidence vs guess)
Skills and domains suggested by descriptions and review discussion; label speculation.

## What they seem to prefer
Work style, scope, communication tone (from comments they and others left).

## Mistakes / friction
Only with PR# citations or quoted paraphrase from the digest. If thin evidence, say so.

## Repeats / iterations
Themes, retries, or review cycles visible in the threads.

## What this sheet still cannot see
Diffs, CI, production metrics, private channels, etc.`;
}

function enrichOptionsFromCli(o: ContributorSheetOptions): EnrichOptions {
  return {
    maxDetailPrs: o.titlesOnly ? 0 : o.maxDetailPrs,
    detailConcurrency: o.detailConcurrency,
    maxIssueCommentsPerPr: o.maxIssueCommentsPerPr,
    maxReviewInlinePerPr: o.maxReviewInlinePerPr,
    maxReviewSummariesPerPr: o.maxReviewSummariesPerPr,
    maxBodyChars: o.maxBodyChars,
    maxCommentChars: o.maxCommentChars,
    includeIssueComments: o.fetchIssueComments,
    includeReviewInline: o.fetchReviewInline,
    includeReviewSummaries: o.fetchReviewSummaries,
  };
}

export async function runContributorSheet(
  owner: string,
  repo: string,
  author: string,
  config: Config,
  options: ContributorSheetOptions
): Promise<string> {
  const octokit = new Octokit({ auth: config.githubToken });
  const spinner = ora(`Fetching PR list for ${author} in ${owner}/${repo}…`).start();
  let fetchResult;
  try {
    fetchResult = await fetchAuthorPrs(octokit, owner, repo, author);
  } catch (err) {
    spinner.fail('GitHub search failed');
    throw err;
  }
  spinner.succeed(
    `Found ${formatNumber(fetchResult.rows.length)} PRs` +
      (fetchResult.totalReported !== fetchResult.rows.length
        ? ` (${formatNumber(fetchResult.totalReported)} reported by GitHub)`
        : '')
  );

  const enrichOpts = enrichOptionsFromCli(options);
  if (enrichOpts.maxDetailPrs > 0) {
    const dSpin = ora(
      `Fetching descriptions & conversations for up to ${formatNumber(enrichOpts.maxDetailPrs)} PR(s)…`
    ).start();
    try {
      await enrichPrRowsWithConversations(octokit, owner, repo, fetchResult.rows, enrichOpts);
    } catch (err) {
      dSpin.fail('Detail fetch failed');
      throw err;
    }
    const detailed = fetchResult.rows.filter(r => r.details).length;
    dSpin.succeed(`Deep data for ${formatNumber(detailed)} PR(s)`);
  }

  if (options.json) {
    return JSON.stringify(
      {
        owner,
        repo,
        author,
        totalReported: fetchResult.totalReported,
        truncated: fetchResult.truncated,
        pullRequests: fetchResult.rows,
      },
      null,
      2
    );
  }

  const { markdown: heuristicMd } = buildHeuristicSheet(owner, repo, author, fetchResult.rows);
  let out = heuristicMd;

  if (options.llm) {
    let userPrompt: string;
    if (options.titlesOnly) {
      const prTable = buildPrListForLlm(owner, repo, fetchResult.rows, options.maxLlmPrLines);
      if (options.verbose) {
        debug('contributor-sheet LLM thin table chars', { chars: prTable.length });
      }
      userPrompt = buildLlmUserPromptThin(owner, repo, author, prTable);
    } else {
      const { text: digest, catalogTruncated, threadTruncated } = buildRichLlmDigest(
        owner,
        repo,
        author,
        fetchResult.rows,
        {
          maxCatalogHead: options.maxCatalogHead,
          maxCatalogTail: options.maxCatalogTail,
          maxTotalChars: options.maxLlmDigestChars,
        }
      );
      if (options.verbose) {
        debug('contributor-sheet LLM digest', {
          chars: digest.length,
          catalogTruncated,
          threadTruncated,
        });
      }
      if (catalogTruncated || threadTruncated) {
        out += `\n> _LLM digest truncated (catalog middle and/or thread blocks) to stay under ${formatNumber(options.maxLlmDigestChars)} characters._\n`;
      }
      userPrompt = buildLlmUserPromptRich(owner, repo, author, digest);
    }

    const llmSpinner = ora('Generating LLM character sheet…').start();
    const llm = new LLMClient(config);
    const response = await llm.complete(userPrompt, LLM_SYSTEM, {
      model: config.llmModel,
    });
    llmSpinner.succeed('LLM section done');
    out += `\n---\n\n# Contributor sheet (LLM — speculative)\n\n${response.content.trim()}\n`;
  }

  if (options.output) {
    writeFileSync(options.output, out, 'utf-8');
    console.log(chalk.gray(`Written to ${options.output}`));
  }

  return out;
}
