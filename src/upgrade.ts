/**
 * Tool upgrade checker and instructions.
 * 
 * Checks versions of installed AI coding tools and provides upgrade instructions.
 */
import chalk from 'chalk';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

interface ToolVersion {
  name: string;
  /** Binary name in PATH (e.g. "claude", "codex", "aider") */
  binary: string;
  installed: boolean;
  version?: string;
  latest?: string;
  upgradeCommand?: string;
  installCommand?: string;
}

/**
 * Check if a command exists in PATH.
 */
async function commandExists(command: string): Promise<boolean> {
  try {
    await execAsync(`which ${command}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get version of a tool by running its version command.
 */
async function getToolVersion(command: string, versionFlag: string = '--version'): Promise<string | null> {
  try {
    const { stdout } = await execAsync(`${command} ${versionFlag}`);
    // Extract version number from output (common formats: v1.2.3, 1.2.3, version 1.2.3)
    const match = stdout.match(/(\d+\.\d+\.\d+)/);
    return match ? match[1] : stdout.trim().split('\n')[0];
  } catch {
    return null;
  }
}

/**
 * Check installed versions of all supported AI coding tools.
 */
export async function checkToolVersions(): Promise<ToolVersion[]> {
  const tools: ToolVersion[] = [];

  // Cursor
  const cursorExists = await commandExists('cursor');
  tools.push({
    name: 'Cursor',
    binary: 'cursor',
    installed: cursorExists,
    version: cursorExists ? await getToolVersion('cursor', '--version') || 'installed' : undefined,
    upgradeCommand: cursorExists ? 'Check for updates in Cursor: Settings → Check for Updates' : undefined,
    installCommand: 'https://cursor.com',
  });

  // Codex (package: @openai/codex)
  const codexExists = await commandExists('codex');
  tools.push({
    name: 'Codex',
    binary: 'codex',
    installed: codexExists,
    version: codexExists ? await getToolVersion('codex', '--version') || 'installed' : undefined,
    upgradeCommand: codexExists ? 'npm install -g @openai/codex' : undefined,
    installCommand: 'npm install -g @openai/codex',
  });

  // Claude Code (binary: "claude", package: @anthropic-ai/claude-code)
  const claudeCodeExists = await commandExists('claude');
  tools.push({
    name: 'Claude Code',
    binary: 'claude',
    installed: claudeCodeExists,
    version: claudeCodeExists ? await getToolVersion('claude', '--version') || 'installed' : undefined,
    upgradeCommand: claudeCodeExists ? 'npm install -g @anthropic-ai/claude-code' : undefined,
    installCommand: 'npm install -g @anthropic-ai/claude-code',
  });

  // Aider (pip package: aider-chat)
  const aiderExists = await commandExists('aider');
  tools.push({
    name: 'Aider',
    binary: 'aider',
    installed: aiderExists,
    version: aiderExists ? await getToolVersion('aider', '--version') || 'installed' : undefined,
    upgradeCommand: aiderExists ? 'pip install --upgrade aider-chat' : undefined,
    installCommand: 'pip install aider-chat',
  });

  // OpenCode
  const opencodeExists = await commandExists('opencode');
  tools.push({
    name: 'OpenCode',
    binary: 'opencode',
    installed: opencodeExists,
    version: opencodeExists ? await getToolVersion('opencode', '--version') || 'installed' : undefined,
    upgradeCommand: opencodeExists ? 'Check repository for updates: https://github.com/opencode/opencode' : undefined,
    installCommand: 'https://github.com/opencode/opencode',
  });

  // Gemini CLI
  const geminiExists = await commandExists('gemini');
  tools.push({
    name: 'Gemini CLI',
    binary: 'gemini',
    installed: geminiExists,
    version: geminiExists ? await getToolVersion('gemini', '--version') || 'installed' : undefined,
    upgradeCommand: geminiExists ? 'npm install -g @google/gemini-cli' : undefined,
    installCommand: 'npm install -g @google/gemini-cli',
  });

  // Junie CLI
  const junieExists = await commandExists('junie');
  tools.push({
    name: 'Junie CLI',
    binary: 'junie',
    installed: junieExists,
    version: junieExists ? await getToolVersion('junie', '--version') || 'installed' : undefined,
    upgradeCommand: junieExists ? 'npm install -g @jetbrains/junie-cli' : undefined,
    installCommand: 'npm install -g @jetbrains/junie-cli',
  });

  // Goose
  const gooseExists = await commandExists('goose');
  tools.push({
    name: 'Goose',
    binary: 'goose',
    installed: gooseExists,
    version: gooseExists ? await getToolVersion('goose', 'version') || await getToolVersion('goose', '--version') || 'installed' : undefined,
    upgradeCommand: gooseExists ? 'brew upgrade goose' : undefined,
    installCommand: 'brew install block/tap/goose',
  });

  // OpenHands
  const openhandsExists = await commandExists('openhands');
  tools.push({
    name: 'OpenHands',
    binary: 'openhands',
    installed: openhandsExists,
    version: openhandsExists ? await getToolVersion('openhands', '--version') || 'installed' : undefined,
    upgradeCommand: openhandsExists ? 'pip install --upgrade openhands-ai' : undefined,
    installCommand: 'pip install openhands-ai',
  });

  return tools;
}

/**
 * Print tool versions and upgrade instructions.
 */
export async function printToolStatus(): Promise<void> {
  console.log(chalk.cyan('\n━━━ AI CODING TOOLS STATUS ━━━\n'));

  const tools = await checkToolVersions();
  
  const installed = tools.filter(t => t.installed);
  const notInstalled = tools.filter(t => !t.installed);

  if (installed.length > 0) {
    console.log(chalk.green('✓ Installed Tools:\n'));
    for (const tool of installed) {
      console.log(chalk.white(`  ${tool.name}`));
      console.log(chalk.gray(`    Version: ${tool.version}`));
      if (tool.upgradeCommand) {
        console.log(chalk.gray(`    Upgrade: ${tool.upgradeCommand}`));
      }
      console.log('');
    }
  }

  if (notInstalled.length > 0) {
    console.log(chalk.yellow('○ Not Installed:\n'));
    for (const tool of notInstalled) {
      console.log(chalk.white(`  ${tool.name}`));
      if (tool.installCommand) {
        console.log(chalk.gray(`    Install: ${tool.installCommand}`));
      }
      console.log('');
    }
  }

  console.log(chalk.cyan('━━━ LATEST MODEL SUPPORT ━━━\n'));
  console.log(chalk.white('  Claude:'));
  console.log(chalk.gray('    • claude-opus-4-6 (most intelligent, best for agents)'));
  console.log(chalk.gray('    • claude-sonnet-4-5-20250929 (balanced speed/intelligence)'));
  console.log(chalk.gray('    • claude-haiku-4-5-20251001 (fastest)'));
  console.log('');
  console.log(chalk.white('  OpenAI:'));
  console.log(chalk.gray('    • gpt-5.3 (latest)'));
  console.log(chalk.gray('    • gpt-5.3-codex (optimized for coding)'));
  console.log(chalk.gray('    • gpt-5.3-mini (fast, cost-effective)'));
  console.log('');

  console.log(chalk.gray('Use --tool <name> to specify which tool to use.'));
  console.log(chalk.gray('Use --model <name> to specify which model to use.'));
  console.log('');
}

/**
 * Update all installed AI coding tools to their latest versions.
 * Runs the upgrade command for each tool that is installed.
 */
export async function updateAllTools(): Promise<void> {
  console.log(chalk.cyan('\n━━━ UPDATING AI CODING TOOLS ━━━\n'));

  const tools = await checkToolVersions();
  const installed = tools.filter(t => t.installed && t.upgradeCommand);
  
  if (installed.length === 0) {
    console.log(chalk.yellow('  No updatable tools found.'));
    console.log(chalk.gray('  Install tools with --check-tools to see options.\n'));
    return;
  }

  for (const tool of installed) {
    // Skip tools that don't have a shell command (e.g. "Check for updates in Cursor")
    if (!tool.upgradeCommand || !isShellCommand(tool.upgradeCommand)) {
      console.log(chalk.gray(`  ○ ${tool.name}: ${tool.upgradeCommand}`));
      continue;
    }

    console.log(chalk.white(`  Updating ${tool.name}...`));
    console.log(chalk.gray(`    $ ${tool.upgradeCommand}`));
    
    try {
      const { stdout, stderr } = await execAsync(tool.upgradeCommand, { timeout: 120_000 });
      
      // Get new version after update
      const newVersion = await getToolVersion(tool.binary, '--version');
      
      if (newVersion && newVersion !== tool.version) {
        console.log(chalk.green(`    ✓ Updated: ${tool.version} → ${newVersion}`));
      } else {
        console.log(chalk.green(`    ✓ Already up to date (${tool.version})`));
      }
      
      // Show any useful output (but keep it short)
      const output = (stdout || '').trim();
      if (output && output.length < 200) {
        console.log(chalk.gray(`    ${output}`));
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.log(chalk.red(`    ✗ Failed: ${errorMsg.split('\n')[0]}`));
    }
    console.log('');
  }

  console.log(chalk.cyan('━━━ DONE ━━━\n'));
}

/**
 * Check if an upgrade command is a shell command (vs. a URL or manual instruction).
 */
function isShellCommand(cmd: string): boolean {
  return !cmd.startsWith('http') && !cmd.startsWith('Check ');
}

/**
 * Check for prr updates.
 */
export async function checkPrrUpdate(): Promise<void> {
  try {
    // Get current version from package.json
    const { default: pkg } = await import('../package.json', { assert: { type: 'json' } });
    const currentVersion = pkg.version;

    console.log(chalk.cyan('\n━━━ PRR VERSION ━━━\n'));
    console.log(chalk.white(`  Current: v${currentVersion}`));
    console.log(chalk.gray('  Repository: https://github.com/elizaos/prr'));
    console.log('');
    console.log(chalk.gray('To update:'));
    console.log(chalk.gray('  git pull origin main'));
    console.log(chalk.gray('  bun install'));
    console.log('');
  } catch (err) {
    console.log(chalk.yellow('  Could not check prr version'));
  }
}
