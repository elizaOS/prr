/**
 * CLI for the story tool: parse PR or branch input and options.
 * WHY Commander: Same as prr/pill; consistent option parsing and --compare as optional string.
 */
import { Command } from 'commander';
import chalk from 'chalk';

export interface StoryOptions {
  output?: string;
  verbose: boolean;
  /** Max commit messages to include in context (first + last when truncated). WHY: Keeps prompt bounded for huge PRs/branches. */
  maxCommits: number;
  /** Max file paths to include; rest summarized as "... and N more files". WHY: Avoids blowing context on thousands of files. */
  maxFiles: number;
  /** When set (branch mode only), second branch for compare; order auto-detected, story from oldest to newest. */
  compareBranch?: string;
}

export interface StoryParsedArgs {
  input: string;
  options: StoryOptions;
}

export function createCLI(): Command {
  const program = new Command();
  program
    .name('story')
    .description(
      'Build a narrative, feature catalog, and changelog from a PR or branch. Accepts a PR URL or a branch spec (owner/repo@branch or repo tree URL).'
    )
    .argument(
      '<pr-or-branch>',
      'PR URL (e.g. https://github.com/owner/repo/pull/123 or owner/repo#123) or branch (e.g. owner/repo@branch or https://github.com/owner/repo/tree/branch)'
    )
    .option('-o, --output <file>', 'Write narrative and changelog to a file instead of stdout')
    .option('-v, --verbose', 'Verbose logging', false)
    .option('--max-commits <n>', 'Max commit messages to include in context (first + last); rest summarized. Default 150.', '150')
    .option('--max-files <n>', 'Max file paths to include; rest summarized. Default 400.', '400')
    .option(
      '--compare <branch>',
      'Second branch (branch mode only): name (e.g. v1-develop), owner/repo@branch, or tree URL. Order is auto-detected; story is oldest → newest.'
    );

  return program;
}

export function parseArgs(program: Command): StoryParsedArgs {
  program.parse();
  const args = program.args as string[];
  const opts = program.opts();
  if (args.length === 0) {
    program.outputHelp();
    process.exit(1);
  }
  const maxCommits = parseInt(String(opts.maxCommits ?? '150'), 10);
  const maxFiles = parseInt(String(opts.maxFiles ?? '400'), 10);
  if (Number.isNaN(maxCommits) || maxCommits < 10) {
    console.error(chalk.red('Error:'), '--max-commits must be a number >= 10');
    process.exit(1);
  }
  if (Number.isNaN(maxFiles) || maxFiles < 10) {
    console.error(chalk.red('Error:'), '--max-files must be a number >= 10');
    process.exit(1);
  }
  const compareBranch = opts.compare ? String(opts.compare).trim() : undefined;
  return {
    input: args[0],
    options: {
      output: opts.output,
      verbose: opts.verbose ?? false,
      maxCommits,
      maxFiles,
      compareBranch: compareBranch && compareBranch.length > 0 ? compareBranch : undefined,
    },
  };
}
