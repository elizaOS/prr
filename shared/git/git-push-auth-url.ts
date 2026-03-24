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

/** GitHub accepts the PAT as the HTTPS username; URL encodes special characters. */
export function buildHttpsPushUrlWithToken(cleanHttpsUrl: string, token: string): string {
  const u = new URL(cleanHttpsUrl);
  u.username = token;
  u.password = '';
  return u.href;
}
