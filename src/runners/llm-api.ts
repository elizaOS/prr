import { writeFileSync, readFileSync, existsSync } from 'fs';
import { dirname, resolve, relative, sep } from 'path';
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
    // Guard: Don't run with empty prompt
    if (!prompt || prompt.trim().length === 0) {
      debug('Empty prompt - skipping LLM API run');
      return { success: false, output: '', error: 'No prompt provided (nothing to fix)' };
    }
    
    debug('LLM API runner starting', { provider: this.provider, workdir, promptLength: prompt.length });

    const { anthropic, openai } = this.getClient();

    // Build system prompt for code editing - use search/replace for minimal changes
    const systemPrompt = `You are an expert code editor. Your task is to fix code issues based on review comments.

CRITICAL RULES:
1. Make MINIMAL, SURGICAL changes - only change what's necessary to fix the issue
2. Do NOT rewrite files, reorganize code, or make unrelated improvements
3. Do NOT change code style, formatting, or structure unless specifically requested
4. Preserve ALL existing code that isn't directly related to the fix
5. If you're unsure, make the smallest possible change

OUTPUT FORMAT - Use search/replace blocks:

<change path="relative/path/to/file.ext">
<search>
exact lines to find (include enough context to be unique)
</search>
<replace>
the replacement lines
</replace>
</change>

You can output multiple <change> blocks. Each <search> must match EXACTLY (including whitespace).
If creating a new file, use:

<newfile path="relative/path/to/new-file.ext">
file contents
</newfile>

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

  private isPathSafe(workdir: string, filePath: string): { safe: boolean; fullPath: string } {
    const workdirResolved = resolve(workdir);
    const fullPath = resolve(workdir, filePath);
    const relativePath = relative(workdirResolved, fullPath);

    // Detect any parent-traversal segments in the relative path
    const hasParentTraversal = relativePath !== '' && relativePath.split(sep).some(segment => segment === '..');

    // Explicitly allow the workdir itself
    if (fullPath === workdirResolved) return { safe: true, fullPath };

    // If the path contains parent traversal, or it does not reside under the workdir, mark as outside
    const isOutside = hasParentTraversal || !fullPath.startsWith(workdirResolved + sep);
    return { safe: !isOutside, fullPath };
  }

  private async applyFileChanges(workdir: string, response: string): Promise<string[]> {
    const filesModified = new Set<string>();
    const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const MAX_WHITESPACE = 1000;
    
    // Parse <change path="..."><search>...</search><replace>...</replace></change> blocks
    const changePattern = /<change\s+path="([^"]+)">\s*<search>([\s\S]*?)<\/search>\s*<replace>([\s\S]*?)<\/replace>\s*<\/change>/g;
    
    let match;
    while ((match = changePattern.exec(response)) !== null) {
      const [, filePath, searchText, replaceText] = match;
      
      const { safe, fullPath } = this.isPathSafe(workdir, filePath);
      if (!safe) {
        debug('Skipping file outside workdir', { filePath });
        continue;
      }

      try {
        if (!existsSync(fullPath)) {
          debug('File not found for search/replace', { filePath });
          continue;
        }

        const originalContent = readFileSync(fullPath, 'utf-8');
        const searchNormalized = searchText.trim();
        
        if (!originalContent.includes(searchNormalized)) {
          debug('Search text not found in file', { filePath, searchLength: searchNormalized.length });
          // Try with normalized whitespace
          const searchLines = searchNormalized.split('\n').map(l => l.trim()).join('\n');
          const contentLines = originalContent.split('\n').map(l => l.trim()).join('\n');
          if (!contentLines.includes(searchLines)) {
            debug('Search text not found even with normalized whitespace', { filePath });
            continue;
          }
          const patternParts = searchNormalized.split(new RegExp(`\\s{1,${MAX_WHITESPACE}}`))
            .map(part => escapeRegExp(part))
            .filter(Boolean);
          const whitespacePattern = patternParts.join(`\\s{1,${MAX_WHITESPACE}}`);
          const whitespaceRegex = new RegExp(whitespacePattern, 'm');
          const newContent = originalContent.replace(whitespaceRegex, replaceText.trim());
          if (newContent === originalContent) {
            debug('Search text found only with normalized whitespace but replacement failed', { filePath, searchLength: searchNormalized.length });
            continue;
          }
          writeFileSync(fullPath, newContent, 'utf-8');
          filesModified.add(filePath);
          debug('Applied whitespace-normalized search/replace', { filePath });
          continue;
        }

        const newContent = originalContent.replace(searchNormalized, replaceText.trim());
        
        if (newContent !== originalContent) {
          writeFileSync(fullPath, newContent, 'utf-8');
          filesModified.add(filePath);
          debug('Applied search/replace', { filePath });
        }
      } catch (error) {
        debug('Failed to apply change', { filePath, error });
      }
    }

    // Also handle <newfile path="...">content</newfile> for new files
    const newfilePattern = /<newfile\s+path="([^"]+)">([\s\S]*?)<\/newfile>/g;
    
    while ((match = newfilePattern.exec(response)) !== null) {
      const [, filePath, content] = match;
      
      const { safe, fullPath } = this.isPathSafe(workdir, filePath);
      if (!safe) {
        debug('Skipping new file outside workdir', { filePath });
        continue;
      }

      try {
        const dir = dirname(fullPath);
        if (!existsSync(dir)) {
          await mkdir(dir, { recursive: true });
        }

        writeFileSync(fullPath, content.trim() + '\n', 'utf-8');
        filesModified.add(filePath);
        debug('Created new file', { filePath });
      } catch (error) {
        debug('Failed to create file', { filePath, error });
      }
    }

    // Fallback: also handle old <file> format for backwards compatibility
    const filePattern = /<file\s+path="([^"]+)"(?:\s+action="([^"]+)")?>([\s\S]*?)<\/file>/g;
    
    while ((match = filePattern.exec(response)) !== null) {
      const [, filePath, , content] = match;
      
      const { safe, fullPath } = this.isPathSafe(workdir, filePath);
      if (!safe) {
        debug('Skipping file outside workdir (legacy format)', { filePath });
        continue;
      }

      // Only use legacy format if no changes were made with new format
      // This prevents overwriting surgical changes with full file rewrites
      if (filesModified.size > 0) {
        debug('Ignoring legacy <file> block - search/replace changes already applied', { filePath });
        continue;
      }

      try {
        const dir = dirname(fullPath);
        if (!existsSync(dir)) {
          await mkdir(dir, { recursive: true });
        }

        writeFileSync(fullPath, content.trim() + '\n', 'utf-8');
        filesModified.add(filePath);
        debug('Wrote file (legacy format)', { filePath });
      } catch (error) {
        debug('Failed to write file', { filePath, error });
      }
    }

    return Array.from(filesModified);
  }
}
