import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { mkdir } from 'fs/promises';
import type { Runner, RunnerResult, RunnerOptions, RunnerStatus } from './types.js';
import { debug } from '../logger.js';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

/**
 * Direct LLM API runner - uses Anthropic or OpenAI API directly to fix code.
 * Useful as a fallback or alternative to CLI-based tools.
 */
export class LLMAPIRunner implements Runner {
  name = 'llm-api';
  displayName = 'Direct LLM API';
  private provider: 'anthropic' | 'openai' = 'anthropic';
  private anthropic?: Anthropic;
  private openai?: OpenAI;

  async isAvailable(): Promise<boolean> {
    if (process.env.ANTHROPIC_API_KEY) {
      this.provider = 'anthropic';
      return true;
    }
    if (process.env.OPENAI_API_KEY) {
      this.provider = 'openai';
      return true;
    }
    return false;
  }

  async checkStatus(): Promise<RunnerStatus> {
    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
    const hasOpenAI = !!process.env.OPENAI_API_KEY;

    if (!hasAnthropic && !hasOpenAI) {
      return {
        installed: false,
        ready: false,
        error: 'No API key found (set ANTHROPIC_API_KEY or OPENAI_API_KEY)',
      };
    }

    this.provider = hasAnthropic ? 'anthropic' : 'openai';
    
    return {
      installed: true,
      ready: true,
      version: this.provider === 'anthropic' ? 'Anthropic Claude' : 'OpenAI GPT',
    };
  }

  private getClient(): { anthropic?: Anthropic; openai?: OpenAI } {
    if (this.provider === 'anthropic' && !this.anthropic) {
      this.anthropic = new Anthropic();
    }
    if (this.provider === 'openai' && !this.openai) {
      this.openai = new OpenAI();
    }
    return { anthropic: this.anthropic, openai: this.openai };
  }

  async run(workdir: string, prompt: string, options?: RunnerOptions): Promise<RunnerResult> {
    debug('LLM API runner starting', { provider: this.provider, workdir, promptLength: prompt.length });

    const { anthropic, openai } = this.getClient();

    // Build system prompt for code editing
    const systemPrompt = `You are an expert code editor. Your task is to fix code issues based on review comments.

IMPORTANT RULES:
1. Output ONLY the file changes in the exact format specified below
2. Do not include explanations outside of the file blocks
3. Make minimal, targeted changes
4. Preserve existing code style and formatting

OUTPUT FORMAT:
For each file you need to modify, output:

<file path="relative/path/to/file.ext">
entire file contents here
</file>

If you need to create a new file:
<file path="relative/path/to/new-file.ext" action="create">
file contents
</file>

Working directory: ${workdir}`;

    try {
      let response: string;

      if (this.provider === 'anthropic' && anthropic) {
        const model = options?.model || 'claude-sonnet-4-20250514';
        debug('Calling Anthropic API', { model });
        
        console.log(`\n🧠 Calling ${model}...\n`);

        const result = await anthropic.messages.create({
          model,
          max_tokens: 16000,
          system: systemPrompt,
          messages: [{ role: 'user', content: prompt }],
        });

        response = result.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map(block => block.text)
          .join('\n');

        debug('Anthropic response received', { 
          inputTokens: result.usage.input_tokens,
          outputTokens: result.usage.output_tokens,
        });
      } else if (this.provider === 'openai' && openai) {
        const model = options?.model || 'gpt-4o';
        debug('Calling OpenAI API', { model });

        console.log(`\n🧠 Calling ${model}...\n`);

        const result = await openai.chat.completions.create({
          model,
          max_tokens: 16000,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ],
        });

        response = result.choices[0]?.message?.content || '';

        debug('OpenAI response received', {
          inputTokens: result.usage?.prompt_tokens,
          outputTokens: result.usage?.completion_tokens,
        });
      } else {
        return {
          success: false,
          output: '',
          error: 'No LLM client available',
        };
      }

      // Parse and apply file changes
      const filesWritten = await this.applyFileChanges(workdir, response);

      if (filesWritten.length === 0) {
        console.log('  No file changes extracted from LLM response');
        return {
          success: true,
          output: response,
        };
      }

      console.log(`  ✓ Modified ${filesWritten.length} file(s): ${filesWritten.join(', ')}`);

      return {
        success: true,
        output: response,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      debug('LLM API error', { error: errorMessage });
      
      return {
        success: false,
        output: '',
        error: errorMessage,
      };
    }
  }

  private async applyFileChanges(workdir: string, response: string): Promise<string[]> {
    const filesWritten: string[] = [];
    
    // Parse <file path="...">content</file> blocks
    const filePattern = /<file\s+path="([^"]+)"(?:\s+action="([^"]+)")?>([\s\S]*?)<\/file>/g;
    
    let match;
    while ((match = filePattern.exec(response)) !== null) {
      const [, filePath, action, content] = match;
      const fullPath = join(workdir, filePath);
      
      // Security check - ensure path is within workdir
      if (!fullPath.startsWith(workdir)) {
        debug('Skipping file outside workdir', { filePath, fullPath });
        continue;
      }

      try {
        // Ensure directory exists
        const dir = dirname(fullPath);
        if (!existsSync(dir)) {
          await mkdir(dir, { recursive: true });
        }

        // Write the file
        writeFileSync(fullPath, content.trim() + '\n', 'utf-8');
        filesWritten.push(filePath);
        debug('Wrote file', { filePath });
      } catch (error) {
        debug('Failed to write file', { filePath, error });
      }
    }

    return filesWritten;
  }
}
