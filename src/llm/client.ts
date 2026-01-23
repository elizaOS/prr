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

Respond with EXACTLY one of these formats:
YES: <quote the problematic code or explain what's still missing>
NO: <cite the specific code that resolves this issue>`;

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
      'You are a STRICT code reviewer verifying whether review comments have been properly addressed.',
      '',
      'RULES:',
      '- Be STRICT: partial fixes, workarounds, or tangentially related changes do NOT count as fixed',
      '- If the comment asks for X and the code does Y, that is NOT fixed unless Y fully addresses X', 
      '- When in doubt, say YES (issue still exists) - false negatives are worse than false positives',
      '',
      'For EACH issue, respond with a line in this exact format:',
      'ISSUE_ID: YES|NO: cite specific code or explain what is missing/fixed',
      '',
      'Example responses:',
      'issue_123: YES: Line 45 still has `user.email` without null check',
      'issue_456: NO: Line 23 now has `if (input === null) return;`',
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
    parts.push('Now analyze each issue STRICTLY and respond with one line per issue:');

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

  /**
   * Final audit: Re-verify ALL issues with an adversarial, stricter prompt.
   * This is run when prr thinks it's done, to catch false positives.
   * Dynamically batches issues based on context size.
   * 
   * @param maxContextChars - Maximum characters per batch (default 100k, ~25k tokens)
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

  async generateCommitMessage(
    fixedIssues: Array<{
      filePath: string;
      comment: string;
    }>
  ): Promise<string> {
    if (fixedIssues.length === 0) {
      return 'fix: address review comments';
    }

    const parts: string[] = [
      'You are writing a git commit message that will be part of permanent project history.',
      'Analyze the review feedback and write a clear, professional commit message.',
      '',
      'COMMIT MESSAGE RULES:',
      '1. First line: conventional commit format, max 72 characters',
      '   - Use "fix:" for bug fixes, "refactor:" for improvements, "feat:" for features',
      '   - Describe WHAT changed, not that you "addressed comments"',
      '2. If there are multiple distinct changes, add a blank line then concise bullet points',
      '3. Focus on the ACTUAL CODE CHANGES, not the review process',
      '4. Write for future developers reading git log - they need to understand what changed and why',
      '5. NO markdown, HTML, emoji, or reviewer metadata',
      '6. NO generic phrases like "address review comments" or "fix issues"',
      '',
      'GOOD EXAMPLES:',
      '```',
      'fix: add null check before accessing user.email',
      '```',
      '',
      '```',
      'refactor: extract validation logic into dedicated helper',
      '',
      '- Move email validation to validateEmail()',
      '- Add unit tests for edge cases',
      '- Update callers to use new helper',
      '```',
      '',
      '```',
      'fix(auth): handle expired tokens gracefully',
      '',
      'Previously threw unhandled exception when token expired during',
      'request. Now returns 401 with clear error message.',
      '```',
      '',
      'BAD EXAMPLES (do not write like this):',
      '- "fix: address review comments" (too vague)',
      '- "fix: update code based on feedback" (says nothing)',
      '- "fix: changes requested by reviewer" (about process, not code)',
      '',
      '---',
      '',
      'Review comments that were addressed (use these to understand what changed):',
      '',
    ];

    for (const issue of fixedIssues) {
      parts.push(`FILE: ${issue.filePath}`);
      parts.push(`FEEDBACK: ${issue.comment}`);
      parts.push('');
    }

    parts.push('---');
    parts.push('');
    parts.push('Write the commit message now. Output ONLY the commit message, nothing else:');

    const response = await this.complete(parts.join('\n'));
    let message = response.content.trim();
    
    // Remove any markdown code fences if the LLM wrapped it
    message = message.replace(/^```\n?/, '').replace(/\n?```$/, '');

    // Ensure the message starts with a conventional commit prefix
    if (!message.match(/^(fix|feat|chore|refactor|docs|style|test|perf)(\(.+\))?:/i)) {
      return `fix: ${message}`;
    }

    return message;
  }
}
