/**
 * CLI for pill - Program Improvement Log Looker.
 * Commander.js: positional <directory>, options. Resolve directory to absolute path.
 */
import { Command, InvalidOptionArgumentError } from 'commander';
import path from 'path';

const TOOLS = ['auto', 'cursor', 'claude-code', 'aider', 'codex', 'gemini', 'llm-api'] as const;
export type ToolOption = (typeof TOOLS)[number];

function validateModel(value: string): string {
  if (!/^[A-Za-z0-9._\/-]+$/.test(value)) {
    throw new InvalidOptionArgumentError(`Invalid model name: "${value}". Use only letters, numbers, dots, slashes, hyphens.`);
  }
  return value;
}

function validateTool(value: string): ToolOption {
  if (!TOOLS.includes(value as ToolOption)) {
    throw new InvalidOptionArgumentError(`Invalid --tool: "${value}". Must be one of: ${TOOLS.join(', ')}`);
  }
  return value as ToolOption;
}

function parsePositiveInt(value: string, optionLabel: string): number {
  const n = parseInt(value, 10);
  if (Number.isNaN(n) || n < 1) {
    throw new InvalidOptionArgumentError(`Invalid ${optionLabel}: "${value}". Must be a positive integer.`);
  }
  return n;
}

export interface CLIOptions {
  tool: ToolOption;
  model: string | undefined;
  auditModel: string;
  maxCycles: number;
  outputOnly: boolean;
  promptsOnly: boolean;
  commit: boolean;
  force: boolean;
  dryRun: boolean;
  verbose: boolean;
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
    .argument('<directory>', 'Target directory containing logs and code to improve')
    .option('-t, --tool <tool>', 'Fixer tool', validateTool, 'auto')
    .option('-m, --model <model>', 'Model for fixer tool', validateModel)
    .option('--audit-model <model>', 'Large model for audit/verify', validateModel, 'claude-opus-4-0-20250514')
    .option('--max-cycles <n>', 'Max fix-verify cycles per run', (v: string) => parsePositiveInt(v, '--max-cycles'), 3)
    .option('--output-only', 'Only use output.log as evidence', false)
    .option('--prompts-only', 'Only use prompts.log as evidence', false)
    .option('--commit', 'Commit changes with a generated message (off by default)', false)
    .option('--force', 'Proceed even if working tree has uncommitted changes', false)
    .option('--dry-run', 'Show audit findings without making changes', false)
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
    tool: opts.tool ?? 'auto',
    model: opts.model,
    auditModel: opts.auditModel ?? 'claude-opus-4-0-20250514',
    maxCycles: opts.maxCycles ?? 3,
    outputOnly: opts.outputOnly ?? false,
    promptsOnly: opts.promptsOnly ?? false,
    commit: opts.commit ?? false,
    force: opts.force ?? false,
    dryRun: opts.dryRun ?? false,
    verbose: opts.verbose ?? false,
  };

  return { directory, options };
}

export function getBanner(): string {
  return BANNER;
}
