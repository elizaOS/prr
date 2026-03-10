/**
 * Redact credentials from URLs in git output or error messages.
 * WHY shared: git-push.ts and git-conflicts.ts both need this; single source of truth
 * so we never log tokens (https://token@... or https://x-access-token:TOKEN@...).
 */
export function redactUrlCredentials(text: string): string {
  return text.replace(/https:\/\/[^@\s]+@/g, 'https://***@');
}
