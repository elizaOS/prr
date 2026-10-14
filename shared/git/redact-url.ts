/**
 * Redact credentials from URLs in git output or error messages.
 * WHY shared: git-push.ts and git-conflicts.ts both need this; single source of truth
 * so we never log tokens (https://token@... or https://x-access-token:TOKEN@...).
 *
 * Handles:
 *   - HTTPS with credentials: https://token@host/... → https://***@host/...
 *   - SSH clone URLs: git@github.com:org/repo → git@***:***
 *   - Authorization headers with base64 tokens
 *
 * WHY include \r: git output on Windows / CI with CRLF line endings could otherwise
 * leave a credential dangling before the carriage return and escape the char class.
 */
export function redactUrlCredentials(text: string): string {
  // HTTPS URLs with embedded credentials (token or user:password)
  let out = text.replace(/https:\/\/[^@\s\r]+@/g, 'https://***@');
  // SSH-style git URLs: git@<host>:<org>/<repo> — no credentials per se, but redact the
  // host+path so private-repo names are not emitted to output.log.
  out = out.replace(/git@[^:\s\r]+:[^\s\r]+/g, 'git@***:***');
  // Redact Git extraheader auth (AUTHORIZATION: basic <base64>) so we never log token-derived base64.
  out = out.replace(/AUTHORIZATION:\s*basic\s+[A-Za-z0-9+/=]+/g, 'AUTHORIZATION: basic ***');
  return out;
}
