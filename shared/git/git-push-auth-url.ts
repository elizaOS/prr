/**
 * Pure helpers for building one-shot HTTPS push URLs with a GitHub token.
 * Used by git-push.ts; covered by tests/git-push-auth-url.test.ts.
 */

/** Remove embedded credentials from an HTTPS URL so we can attach a fresh token. */
export function stripHttpsUserinfo(url: string): string {
  if (!url.startsWith('https://')) return url;
  try {
    const u = new URL(url);
    u.username = '';
    u.password = '';
    return u.href;
  } catch {
    return url.replace(/^https:\/\/[^/@]+@/, 'https://');
  }
}

export function httpsRemoteHasUserinfo(url: string): boolean {
  if (!url.startsWith('https://')) return false;
  try {
    const u = new URL(url);
    return u.username !== '' || u.password !== '';
  } catch {
    return url.includes('@');
  }
}

/**
 * Build a push URL with the token embedded as credentials.
 *
 * WHY x-access-token: GitHub installation tokens (ghs_*) and fine-grained PATs
 * require `x-access-token:<token>` (username:password). Classic PATs (ghp_*) also
 * accept this format. Using token-as-username-only (`<token>@`) causes git to prompt
 * for a password in CI (`fatal: could not read Password … terminal prompts disabled`).
 */
export function buildHttpsPushUrlWithToken(cleanHttpsUrl: string, token: string): string {
  const u = new URL(cleanHttpsUrl);
  u.username = 'x-access-token';
  u.password = token;
  return u.href;
}
