import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { Config, LLMProvider } from '../config.js';
import { debug, trackTokens } from '../logger.js';

export interface LLMResponse {
  content: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

export class LLMClient {
  private provider: LLMProvider;
  private model: string;
  private anthropic?: Anthropic;
  private openai?: OpenAI;
  private thinkingBudget?: number;

  constructor(config: Config) {
    this.provider = config.llmProvider;
    this.model = config.llmModel;
    this.thinkingBudget = config.anthropicThinkingBudget;

    if (this.provider === 'anthropic') {
      this.anthropic = new Anthropic({
        apiKey: config.anthropicApiKey,
      });
      if (this.thinkingBudget) {
        debug(`Extended thinking enabled with budget: ${this.thinkingBudget} tokens`);
      }
    } else {
      this.openai = new OpenAI({
        apiKey: config.openaiApiKey,
      });
    }
  }

  async complete(prompt: string, systemPrompt?: string): Promise<LLMResponse> {
    debug(`LLM request to ${this.provider}/${this.model}`, {
      promptLength: prompt.length,
      hasSystemPrompt: !!systemPrompt,
    });
    
    const response = this.provider === 'anthropic' 
      ? await this.completeAnthropic(prompt, systemPrompt)
      : await this.completeOpenAI(prompt, systemPrompt);
    
    debug('LLM response', {
      responseLength: response.content.length,
      usage: response.usage,
    });
    
    // Track token usage
    if (response.usage) {
      trackTokens(response.usage.inputTokens, response.usage.outputTokens);
    }
    
    return response;
  }

  private async completeAnthropic(prompt: string, systemPrompt?: string): Promise<LLMResponse> {
    if (!this.anthropic) {
      throw new Error('Anthropic client not initialized');
    }

    // Build request options
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const requestOptions: any = {
      model: this.model,
      max_tokens: this.thinkingBudget ? 16000 : 4096,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    };

    // Add extended thinking if budget is set
    if (this.thinkingBudget) {
      requestOptions.thinking = {
        type: 'enabled',
        budget_tokens: this.thinkingBudget,
      };
      debug('Using extended thinking', { budget: this.thinkingBudget });
    } else {
      // Only use system prompt when not using extended thinking
      // (extended thinking doesn't support system prompts)
      requestOptions.system = systemPrompt || 'You are a helpful code review assistant.';
    }

    const response = await this.anthropic.messages.create(requestOptions);

    // Extract text content (skip thinking blocks)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const textBlock = response.content.find((block: any) => block.type === 'text');
    const content = textBlock && 'text' in textBlock ? textBlock.text : '';

    // Log thinking if present (extended thinking feature)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const thinkingBlock = response.content.find((block: any) => block.type === 'thinking');
    if (thinkingBlock && 'thinking' in thinkingBlock) {
      debug('Extended thinking output', (thinkingBlock as any).thinking);
    }

    return {
      content,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }

  private async completeOpenAI(prompt: string, systemPrompt?: string): Promise<LLMResponse> {
    if (!this.openai) {
      throw new Error('OpenAI client not initialized');
    }

    const messages: OpenAI.ChatCompletionMessageParam[] = [];
    
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    
    messages.push({ role: 'user', content: prompt });

    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages,
      max_tokens: 4096,
    });

    const content = response.choices[0]?.message?.content || '';

    return {
      content,
      usage: response.usage
        ? {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
          }
        : undefined,
    };
  }

  async checkIssueExists(
    comment: string,
    filePath: string,
    line: number | null,
    codeSnippet: string
  ): Promise<{ exists: boolean; explanation: string }> {
    const prompt = `Given this code review comment:
---
File: ${filePath}
${line ? `Line: ${line}` : 'Line: (not specified)'}
Comment: ${comment}
---

And the current code at that location:
---
${codeSnippet}
---

Is this issue STILL PRESENT in the code? 

Respond with exactly one of these formats:
YES: <brief explanation of why the issue still exists>
NO: <brief explanation of why the issue has been resolved>`;

    const response = await this.complete(prompt);
    const content = response.content.trim();
    
    const exists = content.toUpperCase().startsWith('YES');
    const explanation = content.replace(/^(YES|NO):\s*/i, '').trim();

    return { exists, explanation };
  }

  async batchCheckIssuesExist(
    issues: Array<{
      id: string;
      comment: string;
      filePath: string;
      line: number | null;
      codeSnippet: string;
    }>
  ): Promise<Map<string, { exists: boolean; explanation: string }>> {
    if (issues.length === 0) {
      return new Map();
    }

    // Build batch prompt
    const parts: string[] = [
      'Analyze each of the following code review comments and determine if the issue is STILL PRESENT in the current code.',
      '',
      'For EACH issue, respond with a line in this exact format:',
      'ISSUE_ID: YES|NO: brief explanation',
      '',
      'Example responses:',
      'issue_123: YES: The null check is still missing',
      'issue_456: NO: The function now validates input',
      '',
      '---',
      '',
    ];

    for (const issue of issues) {
      parts.push(`## Issue ${issue.id}`);
      parts.push(`File: ${issue.filePath}${issue.line ? `:${issue.line}` : ''}`);
      parts.push(`Comment: ${issue.comment}`);
      parts.push('');
      parts.push('Current code:');
      parts.push('```');
      parts.push(issue.codeSnippet);
      parts.push('```');
      parts.push('');
    }

    parts.push('---');
    parts.push('');
    parts.push('Now analyze each issue and respond with one line per issue:');

    const response = await this.complete(parts.join('\n'));
    const results = new Map<string, { exists: boolean; explanation: string }>();

    // Parse responses
    const lines = response.content.split('\n');
    for (const line of lines) {
      // Match patterns like "issue_123: YES: explanation" or "ISSUE_123: NO: explanation"
      const match = line.match(/^([^:]+):\s*(YES|NO):\s*(.*)$/i);
      if (match) {
        const [, id, yesNo, explanation] = match;
        const cleanId = id.trim().toLowerCase().replace(/^issue[_\s]*/i, '');
        results.set(cleanId, {
          exists: yesNo.toUpperCase() === 'YES',
          explanation: explanation.trim(),
        });
      }
    }

    return results;
  }

  async verifyFix(
    comment: string,
    filePath: string,
    diff: string
  ): Promise<{ fixed: boolean; explanation: string }> {
    const prompt = `Given this code review comment:
---
Comment: ${comment}
File: ${filePath}
---

And this code change (diff):
---
${diff}
---

Does this change adequately address the concern raised in the comment?

Respond with exactly one of these formats:
YES: <brief explanation of how the change addresses the issue>
NO: <brief explanation of what's still missing or wrong>`;

    const response = await this.complete(prompt);
    const content = response.content.trim();
    
    const fixed = content.toUpperCase().startsWith('YES');
    const explanation = content.replace(/^(YES|NO):\s*/i, '').trim();

    return { fixed, explanation };
  }

  async batchVerifyFixes(
    fixes: Array<{
      id: string;
      comment: string;
      filePath: string;
      diff: string;
    }>
  ): Promise<Map<string, { fixed: boolean; explanation: string }>> {
    if (fixes.length === 0) {
      return new Map();
    }

    // Build batch prompt
    const parts: string[] = [
      'Verify whether each of the following code changes adequately addresses the review comment.',
      '',
      'For EACH fix, respond with a line in this exact format:',
      'FIX_ID: YES|NO: brief explanation',
      '',
      'Example responses:',
      'fix_123: YES: The null check was added as requested',
      'fix_456: NO: The validation is incomplete, missing edge case',
      '',
      '---',
      '',
    ];

    for (const fix of fixes) {
      parts.push(`## Fix ${fix.id}`);
      parts.push(`File: ${fix.filePath}`);
      parts.push(`Review Comment: ${fix.comment}`);
      parts.push('');
      parts.push('Code Change (diff):');
      parts.push('```diff');
      parts.push(fix.diff);
      parts.push('```');
      parts.push('');
    }

    parts.push('---');
    parts.push('');
    parts.push('Now verify each fix and respond with one line per fix:');

    debug('Batch verifying fixes', { count: fixes.length });
    const response = await this.complete(parts.join('\n'));
    const results = new Map<string, { fixed: boolean; explanation: string }>();

    // Parse responses
    const lines = response.content.split('\n');
    for (const line of lines) {
      // Match patterns like "fix_123: YES: explanation" or "FIX_123: NO: explanation"
      const match = line.match(/^([^:]+):\s*(YES|NO):\s*(.*)$/i);
      if (match) {
        const [, id, yesNo, explanation] = match;
        const cleanId = id.trim().toLowerCase().replace(/^fix[_\s]*/i, '');
        results.set(cleanId, {
          fixed: yesNo.toUpperCase() === 'YES',
          explanation: explanation.trim(),
        });
      }
    }

    debug('Batch verify results', { parsed: results.size, expected: fixes.length });
    return results;
  }

  async resolveConflict(
    filePath: string,
    conflictedContent: string,
    baseBranch: string
  ): Promise<{ resolved: boolean; content: string; explanation: string }> {
    const prompt = `You are resolving a Git merge conflict.

FILE: ${filePath}
MERGING: ${baseBranch} into current branch

The file contains conflict markers (<<<<<<<, =======, >>>>>>>).
Your job is to resolve the conflict intelligently by merging both sides.

CONFLICTED FILE CONTENT:
\`\`\`
${conflictedContent}
\`\`\`

INSTRUCTIONS:
1. Analyze what each side (HEAD and ${baseBranch}) is trying to accomplish
2. Merge the changes intelligently - combine both when possible, don't just pick one side
3. Remove ALL conflict markers (<<<<<<<, =======, >>>>>>>)
4. Ensure the result is valid, working code

Respond in this EXACT format:

EXPLANATION: <brief explanation of how you merged the changes>

RESOLVED:
\`\`\`
<the complete resolved file content with no conflict markers>
\`\`\``;

    debug('Resolving conflict via LLM API', { filePath, contentLength: conflictedContent.length });
    
    const response = await this.complete(prompt);
    const content = response.content;
    
    // Parse the response
    const explanationMatch = content.match(/EXPLANATION:\s*(.+?)(?=\n\nRESOLVED:|$)/s);
    const resolvedMatch = content.match(/RESOLVED:\s*```[^\n]*\n([\s\S]*?)```/);
    
    if (!resolvedMatch) {
      debug('Failed to parse LLM conflict resolution response');
      return {
        resolved: false,
        content: conflictedContent,
        explanation: 'Failed to parse LLM response',
      };
    }

    const resolvedContent = resolvedMatch[1];
    const explanation = explanationMatch ? explanationMatch[1].trim() : 'Resolved';

    // Verify no conflict markers remain
    const hasConflictMarkers = resolvedContent.includes('<<<<<<<') || 
                               resolvedContent.includes('=======') || 
                               resolvedContent.includes('>>>>>>>');

    if (hasConflictMarkers) {
      debug('LLM response still contains conflict markers');
      return {
        resolved: false,
        content: conflictedContent,
        explanation: 'Response still contains conflict markers',
      };
    }

    return {
      resolved: true,
      content: resolvedContent,
      explanation,
    };
  }
}
