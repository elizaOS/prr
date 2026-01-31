/**
 * LLM client for verification, issue detection, and commit message generation.
 * 
 * WHY separate from fixer tools: Verification needs different models than fixing.
 * We use Claude Haiku/Sonnet for fast verification checks, while fixer tools
 * might use Opus or GPT for actual code changes.
 * 
 * WHY extended thinking support: For complex verification, Claude's "thinking"
 * capability improves accuracy by reasoning through the problem before answering.
 * 
 * WHY adversarial prompts: Regular "is this fixed?" prompts have high false positive
 * rates - LLMs tend toward "yes". Adversarial prompts ("find what's NOT fixed")
 * are more reliable.
 */
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { Config, LLMProvider } from '../config.js';
import { debug, trackTokens, debugPrompt, debugResponse } from '../logger.js';

export interface LLMResponse {
  content: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

/**
 * Batch check result with optional model recommendation
 */
export interface BatchCheckResult {
  issues: Map<string, { exists: boolean; explanation: string }>;
  /** Recommended models to use for fixing, in order of preference */
  recommendedModels?: string[];
  /** Reasoning behind the model recommendation */
  modelRecommendationReasoning?: string;
}

/**
 * Context for model recommendation (optional)
 */
export interface ModelRecommendationContext {
  /** Available models to choose from */
  availableModels?: string[];
  /** Historical model performance summary (e.g., "sonnet: 5 fixes, 2 failures") */
  modelHistory?: string;
  /** Previous attempts on these issues (e.g., "sonnet failed: lesson was X") */
  attemptHistory?: string;
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
    
    // Log full prompt to debug file
    const fullPrompt = systemPrompt ? `[SYSTEM]\n${systemPrompt}\n\n[USER]\n${prompt}` : prompt;
    debugPrompt(`llm-${this.provider}`, fullPrompt, { model: this.model });
    
    const response = this.provider === 'anthropic' 
      ? await this.completeAnthropic(prompt, systemPrompt)
      : await this.completeOpenAI(prompt, systemPrompt);
    
    debug('LLM response', {
      responseLength: response.content.length,
      usage: response.usage,
    });
    
    // Log full response to debug file
    debugResponse(`llm-${this.provider}`, response.content, { 
      model: this.model, 
      usage: response.usage 
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

    const maxTokens = requestOptions.max_tokens;
    if (this.thinkingBudget && this.thinkingBudget >= maxTokens) {
      throw new Error(`PRR_THINKING_BUDGET (${this.thinkingBudget}) must be < max_tokens (${maxTokens})`);
    }

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
    const content = response.content
      .filter((block: any) => block.type === 'text' && 'text' in block)
      .map((block: any) => block.text)
      .join('');

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
    const prompt = `You are a strict code reviewer verifying whether a review comment has been properly addressed.

REVIEW COMMENT:
---
File: ${filePath}
${line ? `Line: ${line}` : 'Line: (not specified)'}
Comment: ${comment}
---

CURRENT CODE AT THAT LOCATION:
---
${codeSnippet}
---

INSTRUCTIONS:
1. Carefully read the review comment to understand EXACTLY what is being requested
2. Examine the code to see if the SPECIFIC issue has been fixed
3. Be STRICT: partial fixes, workarounds, or tangentially related changes do NOT count
4. If the comment asks for X and the code does Y, that is NOT fixed unless Y fully addresses X

Is this SPECIFIC issue STILL PRESENT in the code?

CRITICAL - Your explanation will be recorded for feedback between the issue generator and judge:
- If you say NO (not present), you MUST provide a DETAILED explanation citing the SPECIFIC code that resolves the issue
- Your explanation helps the generator learn to avoid false positives
- Empty or vague explanations are NOT acceptable - be specific and cite actual code

Respond with EXACTLY one of these formats:
YES: <quote the problematic code or explain what's still missing>
NO: <cite the SPECIFIC code/line that resolves this issue and explain HOW it addresses the comment>

Examples of GOOD explanations:
NO: Line 45 now has null check: if (value === null) return;
NO: TypeScript type 'NonNullable<T>' at line 23 prevents null from being passed
NO: Function already implements this at lines 67-70: try { ... } catch (error) { logger.error(error); }

Examples of BAD explanations (NEVER do this):
NO: Fixed
NO: Already done
NO: Looks good`;

    const response = await this.complete(prompt);
    const content = response.content.trim();

    const exists = content.toUpperCase().startsWith('YES');
    const explanation = content.replace(/^(YES|NO):\s*/i, '').trim();

    return { exists, explanation };
  }

  /**
   * Batch check if issues still exist, with dynamic batching for large issue sets.
   * 
   * WHY BATCHING: 100 issues × 3KB each = 300KB prompt, which exceeds model limits.
   * We split into multiple batches based on maxContextChars.
   * 
   * @param maxContextChars - Maximum characters per batch (default 150k, ~37k tokens, safe for most models)
   */
  async batchCheckIssuesExist(
    issues: Array<{
      id: string;
      comment: string;
      filePath: string;
      line: number | null;
      codeSnippet: string;
    }>,
    modelContext?: ModelRecommendationContext,
    maxContextChars: number = 150_000
  ): Promise<BatchCheckResult> {
    if (issues.length === 0) {
      return { issues: new Map() };
    }

    // Build the static prompt header (used for each batch)
    const headerParts: string[] = [
      'You are a STRICT code reviewer verifying whether review comments have been properly addressed.',
      '',
      'RULES:',
      '- Be STRICT: partial fixes, workarounds, or tangentially related changes do NOT count as fixed',
      '- If the comment asks for X and the code does Y, that is NOT fixed unless Y fully addresses X',
      '- When in doubt, say YES (issue still exists) - false negatives are worse than false positives',
      '',
      'CRITICAL - Your explanations will be recorded for feedback between the issue generator and judge:',
      '- For NO (not present), you MUST cite the SPECIFIC code that resolves the issue',
      '- Your explanations help the generator learn to avoid false positives',
      '- Empty or vague explanations like "Fixed" or "Looks good" are NOT acceptable',
      '- Be specific and cite actual code/line numbers',
      '',
      'For EACH issue, respond with a line in this exact format:',
      'ISSUE_ID: YES|NO: cite specific code or explain what is missing/fixed',
      '',
      'Example GOOD responses:',
      'issue_1: YES: Line 45 still has `user.email` without null check',
      'issue_2: NO: Line 23 now has `if (input === null) return;` guard',
      'issue_3: NO: TypeScript NonNullable<T> at line 67 prevents null',
      '',
      'Example BAD responses (NEVER do this):',
      'issue_1: NO: Fixed',
      'issue_2: NO: Done',
      'issue_3: NO: Already implemented',
      '',
      '---',
      '',
    ];
    
    const headerSize = headerParts.join('\n').length;
    const footerSize = 200; // Reserve space for closing instructions
    const modelRecSize = modelContext?.availableModels?.length ? 1500 : 0; // Reserve for model recommendation
    const availableForIssues = maxContextChars - headerSize - footerSize - modelRecSize;

    // Build issue text for sizing
    const buildIssueText = (issue: typeof issues[0]): string => {
      // Truncate long comments and code to keep batches reasonable
      const maxCommentLen = 800;
      const maxCodeLen = 1500;
      const truncatedComment = issue.comment.length > maxCommentLen
        ? issue.comment.substring(0, maxCommentLen) + '...'
        : issue.comment;
      const truncatedCode = issue.codeSnippet.length > maxCodeLen
        ? issue.codeSnippet.substring(0, maxCodeLen) + '\n... (truncated)'
        : issue.codeSnippet;

      return [
        `## Issue ${issue.id}`,
        `File: ${issue.filePath}${issue.line ? `:${issue.line}` : ''}`,
        `Comment: ${truncatedComment}`,
        '',
        'Current code:',
        '```',
        truncatedCode,
        '```',
        '',
      ].join('\n');
    };

    // Build batches dynamically based on content size
    const batches: Array<{ issues: typeof issues; issueTexts: string[] }> = [];
    let currentBatch: typeof issues = [];
    let currentTexts: string[] = [];
    let currentSize = 0;

    for (const issue of issues) {
      const issueText = buildIssueText(issue);
      const issueSize = issueText.length;

      // If adding this issue would exceed limit, start a new batch
      if (currentSize + issueSize > availableForIssues && currentBatch.length > 0) {
        batches.push({ issues: currentBatch, issueTexts: currentTexts });
        currentBatch = [];
        currentTexts = [];
        currentSize = 0;
      }

      currentBatch.push(issue);
      currentTexts.push(issueText);
      currentSize += issueSize;
    }

    // Don't forget the last batch
    if (currentBatch.length > 0) {
      batches.push({ issues: currentBatch, issueTexts: currentTexts });
    }

    debug('Batch check batches', { 
      total: issues.length,
      batches: batches.length, 
      sizes: batches.map(b => ({ issues: b.issues.length, chars: b.issueTexts.join('').length })),
      maxContextChars,
    });

    // Process all batches
    const allResults = new Map<string, { exists: boolean; explanation: string }>();
    let recommendedModels: string[] | undefined;
    let modelRecommendationReasoning: string | undefined;

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const { issues: batchIssues, issueTexts } = batches[batchIdx];
      const isFirstBatch = batchIdx === 0;
      
      debug(`Processing batch ${batchIdx + 1}/${batches.length}`, { 
        issueCount: batchIssues.length,
        chars: issueTexts.join('').length + headerSize + footerSize
      });

      // Build prompt for this batch
      const parts = [
        ...headerParts,
        ...issueTexts,
        '---',
        '',
        'Now analyze each issue STRICTLY and respond with one line per issue:',
      ];

      // Only ask for model recommendation in first batch
      if (isFirstBatch && modelContext?.availableModels?.length) {
        parts.push('');
        parts.push('---');
        parts.push('');
        parts.push('## Model Recommendation');
        parts.push('');
        parts.push('After analyzing the issues above, recommend which AI models should attempt to fix them.');
        parts.push(`Available models (in order): ${modelContext.availableModels.join(', ')}`);
        parts.push('');
        parts.push('Consider:');
        parts.push('- Issue complexity: security/refactoring issues need capable models, typos/style can use fast models');
        parts.push('- Issue count and diversity: many issues or multi-file changes need capable models');
        parts.push('- Previous attempts: if a model already failed, try a different one');
        parts.push('');
        
        if (modelContext.modelHistory) {
          parts.push('## Model Performance on This Codebase');
          parts.push(modelContext.modelHistory);
          parts.push('');
        }
        
        if (modelContext.attemptHistory) {
          parts.push('## Previous Attempts on These Issues');
          parts.push(modelContext.attemptHistory);
          parts.push('');
        }
        
        parts.push('End your response with this line:');
        parts.push('MODEL_RECOMMENDATION: model1, model2, model3 | brief reasoning');
        parts.push('');
        parts.push('Examples:');
        parts.push('MODEL_RECOMMENDATION: claude-sonnet-4-5, gpt-5.2 | Complex security issues, skip mini models');
        parts.push('MODEL_RECOMMENDATION: gpt-5-mini, claude-haiku | Simple style/formatting fixes only');
      }

      const response = await this.complete(parts.join('\n'));
      const allowedIds = new Set(batchIssues.map(issue => issue.id.toLowerCase()));

      // Parse issue responses
      const lines = response.content.split('\n');
      for (const line of lines) {
        const match = line.match(/^([^:]+):\s*(YES|NO):\s*(.*)$/i);
        if (match) {
          const [, id, yesNo, explanation] = match;
          const normalizedId = id.trim().toLowerCase().replace(/^issue[_\s]*/i, '').replace(/^#/, '');
          const resultId = normalizedId.length > 0 ? `issue_${normalizedId}` : normalizedId;
          if (!allowedIds.has(resultId)) {
            debug('Ignoring unmatched batch issue id', { id: id.trim(), resultId });
            continue;
          }
          allResults.set(resultId, {
            exists: yesNo.toUpperCase() === 'YES',
            explanation: explanation.trim(),
          });
        }
      }

      // Parse model recommendation only from first batch
      if (isFirstBatch && modelContext?.availableModels?.length) {
        const modelMatch = response.content.match(/MODEL_RECOMMENDATION:\s*([^|\n]+)\|?\s*(.*)?$/im);
        if (modelMatch) {
          const modelList = modelMatch[1];
          const reasoning = modelMatch[2]?.trim();
          
          const availableSet = new Set(modelContext.availableModels.map(m => m.toLowerCase()));
          recommendedModels = modelList
            .split(',')
            .map(m => m.trim())
            .filter(m => {
              const lower = m.toLowerCase();
              if (availableSet.has(lower)) return true;
              for (const avail of modelContext.availableModels!) {
                if (avail.toLowerCase().includes(lower) || lower.includes(avail.toLowerCase())) {
                  return true;
                }
              }
              return false;
            })
            .map(m => {
              const lower = m.toLowerCase();
              for (const avail of modelContext.availableModels!) {
                if (avail.toLowerCase() === lower) return avail;
                if (avail.toLowerCase().includes(lower) || lower.includes(avail.toLowerCase())) {
                  return avail;
                }
              }
              return m;
            });
          
          modelRecommendationReasoning = reasoning || undefined;
          
          if (recommendedModels.length > 0) {
            debug('LLM model recommendation', { 
              recommendedModels, 
              reasoning: modelRecommendationReasoning,
            });
          }
        }
      }
    }

    debug('Batch check complete', { 
      parsed: allResults.size, 
      expected: issues.length,
      batches: batches.length,
    });

    return {
      issues: allResults,
      recommendedModels: recommendedModels?.length ? recommendedModels : undefined,
      modelRecommendationReasoning,
    };
  }

  /**
   * Final audit: Re-verify ALL issues with an adversarial, stricter prompt.
   * 
   * WHY THIS EXISTS:
   * Regular verification can have false positives - the LLM says "looks fixed"
   * when it isn't. These get cached and persist forever. The final audit:
   * 
   * 1. Runs AFTER all issues appear resolved (cache says everything is fixed)
   * 2. Cache is cleared before audit - audit results are authoritative
   * 3. Uses adversarial prompt: "Find issues NOT properly fixed"
   * 4. Requires citing specific code evidence, not just "looks good"
   * 5. Any failures get unmarked and re-enter the fix loop
   * 
   * WHY ADVERSARIAL:
   * Regular prompts ask "is this fixed?" - LLMs tend toward yes.
   * Adversarial prompts ask "what's wrong?" - catches more issues.
   * 
   * WHY DYNAMIC BATCHING:
   * 36 issues × 3KB = 108KB prompt. Too big for some models.
   * We batch based on actual content size, not fixed counts.
   * 
   * @param maxContextChars - Maximum characters per batch (default 400k, ~100k tokens)
   */
  async finalAudit(
    issues: Array<{
      id: string;
      comment: string;
      filePath: string;
      line: number | null;
      codeSnippet: string;
    }>,
    maxContextChars: number = 400_000
  ): Promise<Map<string, { stillExists: boolean; explanation: string }>> {
    if (issues.length === 0) {
      return new Map();
    }

    debug('Running final audit on all issues', { count: issues.length, maxContextChars });

    // Build the static prompt header (used for each batch)
    const headerParts = [
      'FINAL AUDIT: You are performing a thorough final review before marking this PR as complete.',
      '',
      'YOUR TASK: Find any issues that were NOT properly fixed. Be adversarial - assume fixes might be incomplete.',
      '',
      'AUDIT RULES (be strict):',
      '1. Read each review comment carefully - understand the EXACT issue being raised',
      '2. Check if the SPECIFIC problem was addressed, not just "something changed"',
      '3. Partial fixes do NOT count - the full issue must be resolved',
      '4. If you cannot find CLEAR EVIDENCE the issue is fixed, mark it as UNFIXED',
      '',
      'RESPONSE FORMAT (use exactly this format for each issue):',
      '[1] FIXED: The code now includes X',
      '[2] UNFIXED: The validation is still missing',
      '',
      '---',
      '',
    ];
    const headerSize = headerParts.join('\n').length;
    const footerSize = 100; // Reserve space for closing instructions
    const availableForIssues = maxContextChars - headerSize - footerSize;

    // Build batches dynamically based on content size
    const batches: Array<{ issues: typeof issues; issueTexts: string[] }> = [];
    let currentBatch: typeof issues = [];
    let currentTexts: string[] = [];
    let currentSize = 0;

    for (const issue of issues) {
      // Build the text for this issue
      const issueText = this.buildIssueText(currentBatch.length + 1, issue);
      const issueSize = issueText.length;

      // If adding this issue would exceed limit, start a new batch
      if (currentSize + issueSize > availableForIssues && currentBatch.length > 0) {
        batches.push({ issues: currentBatch, issueTexts: currentTexts });
        currentBatch = [];
        currentTexts = [];
        currentSize = 0;
      }

      // Re-index if we started a new batch
      const indexedText = this.buildIssueText(currentBatch.length + 1, issue);
      currentBatch.push(issue);
      currentTexts.push(indexedText);
      currentSize += indexedText.length;
    }

    // Don't forget the last batch
    if (currentBatch.length > 0) {
      batches.push({ issues: currentBatch, issueTexts: currentTexts });
    }

    debug('Final audit batches', { 
      batches: batches.length, 
      sizes: batches.map(b => ({ issues: b.issues.length, chars: b.issueTexts.join('').length }))
    });

    const allResults = new Map<string, { stillExists: boolean; explanation: string }>();

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const { issues: batch, issueTexts } = batches[batchIdx];
      const batchChars = issueTexts.join('').length + headerSize + footerSize;
      debug(`Processing audit batch ${batchIdx + 1}/${batches.length}`, { 
        issueCount: batch.length,
        chars: batchChars 
      });

      // Build full prompt
      const parts = [
        ...headerParts,
        ...issueTexts,
        '---',
        `Respond with exactly ${batch.length} lines, one per issue [1] through [${batch.length}]:`,
      ];

      const response = await this.complete(parts.join('\n'));

      // Parse responses - match [N] FIXED/UNFIXED pattern
      const lines = response.content.split('\n');
      for (const line of lines) {
        // Match patterns like "[1] FIXED: explanation" or "[2] UNFIXED: explanation"
        const match = line.match(/^\[(\d+)\]\s*(FIXED|UNFIXED):\s*(.*)$/i);
        if (match) {
          const [, numStr, status, explanation] = match;
          const idx = parseInt(numStr, 10) - 1;
          if (idx >= 0 && idx < batch.length) {
            const issue = batch[idx];
            allResults.set(issue.id, {
              stillExists: status.toUpperCase() === 'UNFIXED',
              explanation: explanation.trim(),
            });
          }
        }
      }
    }

    const parsed = allResults.size;
    const unfixed = Array.from(allResults.values()).filter(r => r.stillExists).length;
    
    debug('Final audit results', { 
      total: issues.length,
      parsed,
      unfixed
    });

    // CRITICAL: If we couldn't parse most responses, that's a failure - don't silently pass
    if (parsed < issues.length * 0.5) {
      debug('WARNING: Failed to parse most audit responses - marking unparsed as needing review');
      // Mark any unparsed issues as potentially unfixed (fail-safe)
      for (const issue of issues) {
        if (!allResults.has(issue.id)) {
          allResults.set(issue.id, {
            stillExists: true,
            explanation: 'Audit response could not be parsed - needs manual review',
          });
        }
      }
    }

    return allResults;
  }

  /**
   * Build the text representation of an issue for the audit prompt
   */
  private buildIssueText(
    index: number,
    issue: { filePath: string; line: number | null; comment: string; codeSnippet: string }
  ): string {
    // Truncate long comments and code to keep batches reasonable
    const maxCommentLen = 800;
    const maxCodeLen = 1500;
    
    const truncatedComment = issue.comment.length > maxCommentLen
      ? issue.comment.substring(0, maxCommentLen) + '...'
      : issue.comment;
    const truncatedCode = issue.codeSnippet.length > maxCodeLen
      ? issue.codeSnippet.substring(0, maxCodeLen) + '\n... (truncated)'
      : issue.codeSnippet;

    return [
      `[${index}] File: ${issue.filePath}${issue.line ? `:${issue.line}` : ''}`,
      `Comment: ${truncatedComment}`,
      'Code:',
      '```',
      truncatedCode,
      '```',
      '',
    ].join('\n');
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

  /**
   * Analyze a failed fix attempt to generate an actionable lesson
   * WHY: Simple "rejected: [reason]" lessons don't help the next attempt.
   * This extracts specific guidance like "don't just X, also need to Y"
   */
  async analyzeFailedFix(
    issue: {
      comment: string;
      filePath: string;
      line: number | null;
    },
    diff: string,
    rejectionReason: string
  ): Promise<string> {
    const prompt = `A code fix attempt was rejected. Analyze what went wrong and extract a specific lesson.

ORIGINAL ISSUE:
File: ${issue.filePath}${issue.line ? `:${issue.line}` : ''}
Review Comment: ${issue.comment}

ATTEMPTED FIX (diff):
${diff.substring(0, 1500)}

REJECTION REASON:
${rejectionReason}

Generate ONE specific, actionable lesson that will help the next fix attempt succeed.

GOOD LESSONS (specific, actionable):
- "When adding validation for X, must also update the error message to mention X"
- "The fix added A but the comment also requires B - need both"
- "Don't just check for null, also handle the empty string case mentioned"
- "The validation was added but in the wrong location - must be before Y"

BAD LESSONS (vague, not actionable):
- "Fix was incomplete" (doesn't say what's missing)
- "Need to try again" (no guidance)
- "The change didn't work" (no specifics)

Respond with ONLY the lesson text, nothing else. Keep it under 150 characters.`;

    try {
      const response = await this.complete(prompt);
      const lesson = response.content.trim();
      
      // Ensure it's not too long and is actually useful
      if (lesson.length > 200) {
        return lesson.substring(0, 197) + '...';
      }
      if (lesson.length < 10) {
        // Too short, fall back to basic lesson
        return `Fix rejected: ${rejectionReason}`;
      }
      
      return lesson;
    } catch (error) {
      // If analysis fails, return basic lesson
      debug('Failed to analyze fix failure', { error });
      return `Fix rejected: ${rejectionReason}`;
    }
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

  /**
   * Generate a clean, meaningful commit message from fixed issues.
   * 
   * WHY LLM-generated: Early versions concatenated review comments verbatim,
   * producing garbage like "fix: address review comments - <details>...".
   * Commit messages are permanent history - they must describe WHAT changed.
   * 
   * WHY forbidden phrases: LLMs default to "address review comments" because
   * that's the most likely completion. We explicitly forbid these and fall back
   * to file-specific messages if detected.
   * 
   * WHY 72 char limit: Git convention. First line should fit in git log --oneline.
   * 
   * WHY truncate issues: 10 issues max, 200 chars each. Keeps prompt focused.
   */
  async generateCommitMessage(
    fixedIssues: Array<{
      filePath: string;
      comment: string;
    }>
  ): Promise<string> {
    if (fixedIssues.length === 0) {
      return 'chore: minor code improvements';
    }

    // Extract file names and key themes from issues
    const files = [...new Set(fixedIssues.map(i => i.filePath.split('/').pop()))];
    const fileList = files.slice(0, 3).join(', ') + (files.length > 3 ? ` (+${files.length - 3})` : '');

    const parts: string[] = [
      'Generate a git commit message for code changes. This is PERMANENT HISTORY.',
      '',
      'ABSOLUTE REQUIREMENTS:',
      '1. First line: type(scope): specific description (max 72 chars)',
      '2. Type: fix/feat/refactor/chore/docs',
      '3. Describe the ACTUAL CHANGE, not "review comments" or "feedback"',
      '',
      '🚫 FORBIDDEN PHRASES (never use these):',
      '- "address review comments"',
      '- "address feedback"', 
      '- "fix issues"',
      '- "update code"',
      '- "apply changes"',
      '- "based on review"',
      '- Any mention of "review", "comments", "feedback", "requested"',
      '',
      'Read the feedback below, understand WHAT was changed, and describe THAT.',
      '',
      `Files changed: ${fileList}`,
      '',
      '---',
      '',
    ];

    // Show feedback with emphasis on extracting the actual change
    for (const issue of fixedIssues.slice(0, 10)) { // Limit to avoid huge prompts
      const fileName = issue.filePath.split('/').pop();
      // Extract just the key issue, truncate long comments
      const shortComment = issue.comment.length > 200 
        ? issue.comment.substring(0, 200) + '...'
        : issue.comment;
      parts.push(`[${fileName}] ${shortComment}`);
      parts.push('');
    }

    parts.push('---');
    parts.push('');
    parts.push('Based on the above, what SPECIFIC CODE CHANGES were made? Write the commit message:');

    const response = await this.complete(parts.join('\n'));
    let message = response.content.trim();
    
    // Remove any markdown code fences if the LLM wrapped it
    message = message.replace(/^```[\w]*\n?/g, '').replace(/\n?```$/g, '');
    message = message.trim();
    
    // Check for forbidden phrases and regenerate if found
    const forbiddenPatterns = [
      /address(ed|ing)?\s+(review\s+)?comments?/i,
      /address(ed|ing)?\s+feedback/i,
      /based on\s+(review|feedback)/i,
      /review(er)?\s+(comments?|feedback)/i,
      /requested\s+changes?/i,
      /apply\s+(the\s+)?changes/i,
    ];
    
    const hasForbidden = forbiddenPatterns.some(p => p.test(message));
    
    if (hasForbidden) {
      debug('Commit message contained forbidden phrase, generating fallback', { message });
      // Generate a simple but specific message from file names
      const mainFile = files[0]?.replace(/\.[^.]+$/, '') || 'code';
      return `fix(${mainFile}): improve ${mainFile} implementation`;
    }

    // Normalize the conventional commit prefix (lowercase, proper colon)
    const prefixMatch = message.match(/^(fix|feat|chore|refactor|docs|style|test|perf)(\([^)]+\))?(?=$|[:\s])/i);
    if (prefixMatch) {
      const type = prefixMatch[1].toLowerCase();
      const scope = prefixMatch[2] ?? '';
      const rest = message.slice(prefixMatch[0].length).replace(/^[:\s]+/, '').trimStart();
      message = rest ? `${type}${scope}: ${rest}` : `${type}${scope}: update`;
    } else {
      // No valid prefix, add one
      message = `fix: ${message}`;
    }
    
    // Truncate first line if too long (72 char limit for commit messages)
    const lines = message.split('\n');
    if (lines[0].length > 72) {
      lines[0] = lines[0].substring(0, 69) + '...';
      message = lines.join('\n');
    }

    return message;
  }
}
