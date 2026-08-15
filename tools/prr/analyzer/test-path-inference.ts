/**
 * Shared helpers for recognizing test-related review comments and inferring
 * test-file targets from source-file comments.
 *
 * WHY: Prompt building, solvability, and retry logic all need to answer the
 * same question: "what test file is this review actually asking about?" If
 * each phase reimplements that logic, they drift and produce conflicting
 * target paths.
 */

export type TestPathIssueLike = {
  comment: {
    path: string;
    body?: string;
  };
  explanation?: string;
};

export function isTestOrSpecPath(path: string): boolean {
  return /(?:^|\/)__tests__\/|(?:^|\/)[^/]+\.(?:test|spec)\.(?:ts|tsx|js|jsx)$/i.test(path);
}

export function issueRequestsTestsText(text: string): boolean {
  return (
    /\b(?:add(?:ing)?|writing|no\s+tests?\s+cover|tests?\s+cover|test\s+coverage)\s+(?:tests?|here|for)\b/i.test(text) ||
    /\b(?:no|missing)\s+tests?\b/i.test(text) ||
    /\b__tests__\b/i.test(text) ||
    /\b(?:vitest|jest|mocha)\b/i.test(text) ||
    /\badding\s+tests?\s+here\s+would\s+help\b/i.test(text)
  );
}

function normalizeRelativePath(path: string): string {
  return path.replace(/\/\.\//g, '/').replace(/\/[^/]+\/\.\.\//g, '/');
}

/**
 * Build `name.test.ts` / `name.spec.ts` from a basename stem (no extension).
 * WHY: When stem is already `foo.test` (from `foo.test.ts`), appending `.test` again yields `foo.test.test.ts` (recovery/prompt-builder audit).
 */
export function testBasenameWithSuffix(stem: string, extWithDot: string, kind: 'test' | 'spec'): string {
  const marker = kind === 'test' ? '.test' : '.spec';
  if (stem.toLowerCase().endsWith(marker)) {
    return `${stem}${extWithDot}`;
  }
  return `${stem}${marker}${extWithDot}`;
}

/** Collapse accidental `.test.test.ts` / `.spec.spec.ts` suffixes (duplicated inference or bot typos). */
export function normalizeDoubledTestExtension(path: string): string {
  return path
    .replace(/\.test\.test\.(ts|tsx|js|jsx)$/i, '.test.$1')
    .replace(/\.spec\.spec\.(ts|tsx|js|jsx)$/i, '.spec.$1');
}

export function getTestPathForIssueLike(
  issue: TestPathIssueLike,
  options?: { pathExists?: (path: string) => boolean; forceTestPath?: boolean; keepExistingTestPath?: boolean }
): string | null {
  const pathExists = options?.pathExists;
  const forceTestPath = options?.forceTestPath === true;
  const keepExistingTestPath = options?.keepExistingTestPath === true;
  const path = issue.comment.path ?? '';
  const body = issue.comment.body ?? '';
  const explanation = issue.explanation ?? '';
  const combined = `${body} ${explanation}`;
  const normOut = (p: string) => normalizeDoubledTestExtension(p.replace(/\\/g, '/'));

  // WHY preserve explicit test paths first: when the review is already anchored on
  // `foo.test.ts`, that path is stronger evidence than the wording in the body.
  // Coverage-only phrasing ("missing coverage here") should not kick the issue out
  // of the create-file/test-file flow just because it doesn't repeat "add tests".
  if (isTestOrSpecPath(path)) return keepExistingTestPath ? normOut(path) : null;
  if (!forceTestPath && !issueRequestsTestsText(combined)) return null;

  const dir = path.includes('/') ? path.replace(/\/[^/]+$/, '') : '';
  const preferOrFallback = (colocated: string, integration: string | null, testsRoot?: string): string => {
    if (pathExists) {
      if (pathExists(colocated)) return colocated;
      if (testsRoot && pathExists(testsRoot)) return testsRoot;
      if (integration && pathExists(integration)) return integration;
    }
    return colocated;
  };

  const explicitFull = body.match(/(?:^|[\s(])`?([a-zA-Z0-9_/.()-]+__tests__[a-zA-Z0-9_/.()-]+\.(?:test|spec)\.(?:ts|js))`?(?:\s|$|[,)])/);
  if (explicitFull?.[1]) return normOut(explicitFull[1].replace(/^[\s(]+|[\s)]+$/g, ''));

  const explicitRel = body.match(/(?:in|to|add\s+tests?\s+to?|tests?\s+in)\s+[`']?([a-zA-Z0-9_/.()-]+\.(?:test|spec)\.(?:ts|js))[`']?(?:\s|$|[,)])/i);
  if (explicitRel?.[1]) {
    const name = explicitRel[1].replace(/^[\s'`]+|[\s'`]+$/g, '');
    if (name.includes('/')) return normOut(name);
    if (dir) {
      const colocated = normalizeRelativePath(`${dir}/${name}`);
      const integration = normalizeRelativePath(`${dir}/../__tests__/integration/${name}`);
      return normOut(preferOrFallback(colocated, integration));
    }
    return normOut(name);
  }

  const backtick = body.match(/`([a-zA-Z0-9_/.()-]+\.(?:test|spec)\.(?:ts|js))`/);
  if (backtick?.[1]) {
    const name = backtick[1];
    if (name.includes('/')) return normOut(name);
    if (dir) {
      const colocated = normalizeRelativePath(`${dir}/${name}`);
      const integration = normalizeRelativePath(`${dir}/../__tests__/integration/${name}`);
      return normOut(preferOrFallback(colocated, integration));
    }
    return normOut(name);
  }

  if (!/\.(?:ts|tsx|js|jsx)$/.test(path)) return null;
  const fileStem = path.replace(/^.*\//, '').replace(/\.(ts|tsx|js|jsx)$/i, '');
  const ext = (path.match(/\.(ts|tsx|js|jsx)$/i) ?? [])[1] ?? 'ts';
  const base = testBasenameWithSuffix(fileStem, `.${ext}`, 'test');
  if (dir) {
    const colocated = normalizeRelativePath(`${dir}/${base}`);
    const integration = normalizeRelativePath(`${dir}/../__tests__/integration/${base}`);
    const testsRoot = `__tests__/${base}`;
    // Same src-level __tests__ (e.g. packages/typescript/src/__tests__/database.test.ts when path is src/types/database.ts). Prompts.log audit: TARGET FILE(S) listed non-existent src/types/database.test.ts.
    const srcLevelTests = /\/src\//.test(dir) ? normalizeRelativePath(`${dir}/../__tests__/${base}`) : null;
    if (pathExists && srcLevelTests) {
      if (pathExists(srcLevelTests)) return normOut(srcLevelTests);
      if (pathExists(colocated)) return normOut(colocated);
      if (pathExists(testsRoot)) return normOut(testsRoot);
      if (integration && pathExists(integration)) return normOut(integration);
      return normOut(srcLevelTests);
    }
    return normOut(preferOrFallback(colocated, integration, testsRoot));
  }
  return normOut(base);
}
