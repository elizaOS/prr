/**
 * Mock LLM client for testing
 */

import { vi } from 'vitest';
import type { LLMClient, BatchCheckResult } from '../../tools/prr/llm/client.js';

export interface MockLLMClientOptions {
  /** Map issue ID to verification response: 'YES' (exists), 'NO' (fixed), 'STALE' */
  checkIssueResponses?: Record<string, { exists: boolean; explanation: string; stale: boolean }>;
  /** Map issue ID to batch check response */
  batchCheckResponses?: Record<string, { exists: boolean; explanation: string; stale: boolean; importance?: number; difficulty?: number }>;
  conflictResolutionResponses?: Record<string, { resolved: boolean; content: string; explanation: string }>;
  completeResponses?: Record<string, string>;
  generateDismissalResponses?: Record<string, { needed: boolean; commentText?: string }>;
}

export function createMockLLMClient(options: MockLLMClientOptions = {}): LLMClient {
  const checkIssueResponses = options.checkIssueResponses || {};
  const batchCheckResponses = options.batchCheckResponses || {};
  const conflictResolutionResponses = options.conflictResolutionResponses || {};
  const completeResponses = options.completeResponses || {};
  const generateDismissalResponses = options.generateDismissalResponses || {};

  return {
    checkIssueExists: vi.fn(async (comment: string, filePath: string, line: number | null, codeSnippet: string, contextHints?: string[]) => {
      // Try to extract issue ID from comment or use filePath+line as key
      const key = `${filePath}:${line}`;
      const response = checkIssueResponses[key] || { exists: true, explanation: 'Mock: issue still exists', stale: false };
      return response;
    }),
    batchCheckIssuesExist: vi.fn(async (issues, modelContext?, maxContextChars?, maxIssuesPerBatch?, phase?) => {
      const resultMap = new Map<string, { exists: boolean; explanation: string; stale: boolean; importance: number; difficulty: number }>();
      for (const issue of issues) {
        const response = batchCheckResponses[issue.id] || { 
          exists: true, 
          explanation: 'Mock: issue still exists', 
          stale: false,
          importance: 3,
          difficulty: 3,
        };
        resultMap.set(issue.id, {
          exists: response.exists,
          explanation: response.explanation,
          stale: response.stale,
          importance: response.importance ?? 3,
          difficulty: response.difficulty ?? 3,
        });
      }
      return { issues: resultMap } as BatchCheckResult;
    }),
    resolveConflict: vi.fn(async (filePath: string, conflictedContent: string, baseBranch: string, options?) => {
      const response = conflictResolutionResponses[filePath] || {
        resolved: true,
        content: conflictedContent.replace(/<<<<<<<.*?=======.*?>>>>>>>/gs, ''),
        explanation: 'Mock: conflict resolved',
      };
      return response;
    }),
    complete: vi.fn(async (prompt: string, systemPrompt?: string, options?) => {
      const response = completeResponses[prompt] || completeResponses['default'] || 'Mock LLM response';
      return {
        content: response,
        usage: { inputTokens: 100, outputTokens: 50 },
      };
    }),
    generateDismissalComment: vi.fn(async (params) => {
      const key = `${params.filePath}:${params.line}`;
      const response = generateDismissalResponses[key] || generateDismissalResponses['default'] || { needed: false };
      return response;
    }),
    // Additional methods that may be needed
    completeWithCheapModel: vi.fn(async (prompt: string, systemPrompt?: string) => {
      return {
        content: 'Mock cheap model response',
        usage: { inputTokens: 50, outputTokens: 25 },
      };
    }),
    setRunAbortSignal: vi.fn(),
    getVerifierModel: vi.fn(() => undefined),
  } as unknown as LLMClient;
}
