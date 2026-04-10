/**
 * Structured logging for GitHub REST/GraphQL failures (especially 5xx with empty bodies).
 * WHY: Operators see "500 status code (no body)" with no request id or endpoint; Octokit puts
 * method/url/headers on the error object — we surface them in debug and warn on server errors.
 */
import { debug, warn, formatNumber } from '../../../shared/logger.js';

export type GitHubErrorSummary = {
  errorName?: string;
  message: string;
  httpStatus?: number;
  requestMethod?: string;
  requestUrl?: string;
  requestId?: string;
  documentationUrl?: string;
  responseDataPreview?: string;
  graphqlErrorMessages?: string[];
};

/**
 * Best-effort extraction from @octokit/request-error HttpError, fetch failures, and GraphqlResponseError.
 */
export function summarizeGitHubError(err: unknown): GitHubErrorSummary {
  if (err == null) {
    return { message: 'null/undefined error' };
  }
  if (typeof err !== 'object') {
    return { message: String(err) };
  }

  const e = err as Record<string, unknown>;
  const message = e.message != null ? String(e.message) : String(err);
  const errorName = typeof e.name === 'string' ? e.name : undefined;

  // GraphQL: HTTP 200 but errors[] in body
  if (e.name === 'GraphqlResponseError' && Array.isArray(e.errors)) {
    const graphqlErrorMessages = (e.errors as Array<{ message?: string }>)
      .map((x) => x.message ?? '')
      .filter(Boolean);
    let requestUrl: string | undefined;
    if (e.request && typeof e.request === 'object') {
      const req = e.request as { url?: string };
      requestUrl = req.url;
    }
    return {
      errorName: 'GraphqlResponseError',
      message,
      graphqlErrorMessages,
      requestUrl,
    };
  }

  const status = typeof e.status === 'number' && !Number.isNaN(e.status) ? e.status : undefined;
  let requestMethod: string | undefined;
  let requestUrl: string | undefined;
  let requestId: string | undefined;
  let documentationUrl: string | undefined;
  let responseDataPreview: string | undefined;

  if (e.request && typeof e.request === 'object') {
    const req = e.request as { method?: string; url?: string };
    requestMethod = req.method;
    requestUrl = req.url;
  }

  if (e.response && typeof e.response === 'object') {
    const res = e.response as {
      headers?: Record<string, string | string[] | undefined>;
      data?: unknown;
      url?: string;
    };
    const h = res.headers;
    if (h) {
      const id = h['x-github-request-id'] ?? h['X-GitHub-Request-Id'];
      requestId = Array.isArray(id) ? id[0] : id;
    }
    if (res.data != null) {
      const s = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
      responseDataPreview = s.length > 300 ? `${s.slice(0, 300)}…` : s;
    }
    if (typeof res.url === 'string' && !requestUrl) {
      requestUrl = res.url;
    }
  }

  // Some clients put documentation_url on the error root
  if (typeof e.documentation_url === 'string') {
    documentationUrl = e.documentation_url;
  }

  return {
    errorName,
    message,
    httpStatus: status,
    requestMethod,
    requestUrl,
    requestId,
    documentationUrl,
    responseDataPreview,
  };
}

/**
 * Log a GitHub API failure: always **debug** (full detail); **warn** on HTTP ≥500 or likely server errors.
 * Call from REST/GraphQL wrappers before rethrowing.
 */
export function logGitHubApiFailure(phase: string, err: unknown, context?: Record<string, unknown>): void {
  const s = summarizeGitHubError(err);
  const payload: Record<string, unknown> = { phase, ...context, github: s };
  debug('GitHub API request failed', payload);

  const status = s.httpStatus;
  const msgLower = s.message.toLowerCase();
  const looksServer =
    (status != null && status >= 500) ||
    /\b5\d\d\b/.test(msgLower) ||
    /internal server|bad gateway|gateway timeout|service unavailable/i.test(msgLower);

  if (looksServer) {
    const parts = [
      `GitHub server or gateway error during "${phase}"`,
      status != null ? `(HTTP ${formatNumber(status)})` : '',
      s.requestMethod && s.requestUrl ? `${s.requestMethod} ${redactGitHubUrl(s.requestUrl)}` : '',
      s.requestId ? `x-github-request-id=${s.requestId}` : '',
    ].filter(Boolean);
    warn(parts.join(' — '));
  } else if (status === 429) {
    warn(`GitHub rate limited during "${phase}"${s.requestId ? ` — x-github-request-id=${s.requestId}` : ''}`);
  }
}

/** Strip query tokens from logged URLs (Octokit often redacts auth; keep defense in depth). */
function redactGitHubUrl(url: string): string {
  return url
    .replace(/\bclient_secret=\w+/gi, 'client_secret=[REDACTED]')
    .replace(/\baccess_token=\w+/gi, 'access_token=[REDACTED]');
}
