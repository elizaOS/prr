/**
 * Parse owner/repo from `owner/repo` or a github.com URL.
 */

const REPO_PATH = /github\.com\/([^/]+)\/([^/?#]+)/i;
const BARE = /^([\w.-]+)\/([\w.-]+)$/;

export interface ParsedRepo {
  owner: string;
  repo: string;
}

export function parseRepoSpec(raw: string): ParsedRepo {
  const s = raw.trim();
  if (!s) throw new Error('Repository is empty.');
  const mUrl = s.match(REPO_PATH);
  if (mUrl) {
    return { owner: mUrl[1], repo: mUrl[2].replace(/\.git$/i, '') };
  }
  const mBare = s.match(BARE);
  if (mBare) {
    return { owner: mBare[1], repo: mBare[2] };
  }
  throw new Error(
    `Invalid repository "${raw}". Use owner/repo or https://github.com/owner/repo`
  );
}

export function normalizeGithubLogin(login: string): string {
  const s = login.trim();
  if (!s) throw new Error('GitHub username is empty.');
  if (!/^[\w-]+$/.test(s)) {
    throw new Error(
      `GitHub username "${login}" contains unsupported characters (use letters, digits, underscore, hyphen).`
    );
  }
  return s;
}
