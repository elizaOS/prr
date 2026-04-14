/**
 * Normalize OpenAI chat completion `message.content` to a string.
 * WHY: The SDK types allow `string | ChatCompletionContentPart[] | null`; coercing with `|| ''`
 * turns array bodies into empty strings — false "empty response" and broken downstream parsers
 * (pill-output / AGENTS empty-body audits).
 */
export function openAiChatCompletionContentToString(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const part of content) {
    if (
      part &&
      typeof part === 'object' &&
      'type' in part &&
      (part as { type: string }).type === 'text' &&
      'text' in part &&
      typeof (part as { text?: unknown }).text === 'string'
    ) {
      out += (part as { text: string }).text;
    }
  }
  return out;
}
