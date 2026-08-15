/**
 * CLI for pill - Program Improvement Log Looker.
 * Commander.js: positional <directory>, options. Resolve directory to absolute path.
 */
import { Command, InvalidOptionArgumentError } from 'commander';
import path from 'path';

function validateModel(value: string): string {
  if (!/^[A-Za-z0-9._\/-]+$/.test(value)) {
    throw new InvalidOptionArgumentError(`Invalid model name: "${value}". Use only letters, numbers, dots, slashes, hyphens.`);
  }
  return value;
}

export interface CLIOptions {
  auditModel: string;
  outputOnly: boolean;
  promptsOnly: boolean;
  dryRun: boolean;
  verbose: boolean;
  instructionsOut?: string;
  /** Resolved absolute path to output log (optional) */
  outputLog?: string;
  /** Resolved absolute path to prompts log (optional) */
  promptsLog?: string;
}

export interface ParsedArgs {
  directory: string;   // absolute path
  options: CLIOptions;
}

const BANNER = `
  ${String.fromCodePoint(0x1f48a)} pill — Program Improvement Log Looker
  Audit and improve code based on output.log and prompts.log
`;

export function createCLI(): Command {
  const program = new Command();

  program
    .name('pill')
    .description('Program Improvement Log Looker - improve code from output.log and prompts.log')
    .version('0.1.0', '-V, --version', 'output the version number')
    .argument(
      '<directory>',
      'Project root for docs/source/tree; logs default here unless --output-log / --prompts-log'
    )
    .option('--audit-model <model>', 'Model for audit', validateModel, 'claude-opus-4-6')
    .option('--output-only', 'Only use output.log as evidence', false)
    .option('--prompts-only', 'Only use prompts.log as evidence', false)
    .option('--dry-run', 'Show audit findings without writing files', false)
    .option('--instructions-out <path>', 'Override path for pill-output.md')
    .option(
      '--output-log <path>',
      'Read this file as output.log (default: <dir>/[prefix-]output.log). Overrides PILL_OUTPUT_LOG_PATH.'
    )
    .option(
      '--prompts-log <path>',
      'Read this file as prompts.log (default: <dir>/[prefix-]prompts.log). Overrides PILL_PROMPTS_LOG_PATH.'
    )
    .option('-v, --verbose', 'Verbose logging', false);

  return program;
}

export function parseArgs(program: Command): ParsedArgs {
  program.parse();
  const opts = program.opts();
  const dirArg = program.processedArgs[0];
  if (!dirArg) {
    program.error('Missing required argument: directory');
  }
  const directory = path.resolve(dirArg);

  const options: CLIOptions = {
    auditModel: opts.auditModel ?? 'claude-opus-4-6',
    outputOnly: opts.outputOnly ?? false,
    promptsOnly: opts.promptsOnly ?? false,
    dryRun: opts.dryRun ?? false,
    verbose: opts.verbose ?? false,
    instructionsOut: opts.instructionsOut,
    outputLog: opts.outputLog !== undefined ? path.resolve(opts.outputLog) : undefined,
    promptsLog: opts.promptsLog !== undefined ? path.resolve(opts.promptsLog) : undefined,
  };

  return { directory, options };
}

export function getBanner(): string {
  return BANNER;
}
