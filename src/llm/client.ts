import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { Config, LLMProvider } from '../config.js';

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

  constructor(config: Config) {
    this.provider = config.llmProvider;
    this.model = config.llmModel;

    if (this.provider === 'anthropic') {
      this.anthropic = new Anthropic({
        apiKey: config.anthropicApiKey,
      });
    } else {
      this.openai = new OpenAI({
        apiKey: config.openaiApiKey,
      });
    }
  }

  async complete(prompt: string, systemPrompt?: string): Promise<LLMResponse> {
    if (this.provider === 'anthropic') {
      return this.completeAnthropic(prompt, systemPrompt);
    } else {
      return this.completeOpenAI(prompt, systemPrompt);
    }
  }

  private async completeAnthropic(prompt: string, systemPrompt?: string): Promise<LLMResponse> {
    if (!this.anthropic) {
      throw new Error('Anthropic client not initialized');
    }

    const response = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: systemPrompt || 'You are a helpful code review assistant.',
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    });

    const textBlock = response.content.find((block) => block.type === 'text');
    const content = textBlock && 'text' in textBlock ? textBlock.text : '';

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
    const prompt = `Given this code review comment from an LLM review bot:
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

  async verifyFix(
    comment: string,
    filePath: string,
    diff: string
  ): Promise<{ fixed: boolean; explanation: string }> {
    const prompt = `Given this code review comment from an LLM review bot:
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
}
