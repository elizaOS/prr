/**
 * Redact credentials from URLs in git output or error messages.
 * WHY shared: git-push.ts and git-conflicts.ts both need this; single source of truth
 * so we never log tokens (https://token@... or https://x-access-token:TOKEN@...).
 */
export function redactUrlCredentials(text: string): string {
  let out = text.replace(/https:\/\/[^@\s]+@/g, 'https://***@');
  // Redact Git extraheader auth (AUTHORIZATION: basic <base64>) so we never log token-derived base64.
  out = out.replace(/AUTHORIZATION:\s*basic\s+[A-Za-z0-9+/=]+/g, 'AUTHORIZATION: basic ***');
  return out;
}
