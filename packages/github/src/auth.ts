import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Octokit } from "@octokit/rest";
import { getSecret, getSetting, type DB } from "@elevate/db";

const exec = promisify(execFile);

/** Settings key for the gh account pinned in Settings → GitHub. */
export const GITHUB_ACCOUNT_SETTING = "github.account";

/**
 * The gh account elevate uses for GitHub and Copilot: GITHUB_USER, else the account pinned in
 * Settings. Undefined means gh's active account, which `gh auth switch` changes.
 */
export async function githubAccount(db?: DB): Promise<string | undefined> {
  if (process.env.GITHUB_USER) return process.env.GITHUB_USER;
  if (!db) return undefined;
  return (await getSetting<string>(db, GITHUB_ACCOUNT_SETTING, "").catch(() => "")) || undefined;
}

/** Resolve a GitHub token: env -> stored (OAuth) secret -> `gh auth token [--user <githubAccount>]`. */
export async function resolveGitHubToken(db?: DB): Promise<string> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (db) {
    const stored = await getSecret(db, "github_token").catch(() => undefined);
    if (stored) return stored;
  }
  const account = await githubAccount(db);
  const token = await ghAccountToken(account);
  if (token) return token;
  throw new Error(
    account
      ? `No GitHub token for ${account}: run \`gh auth login\` for that account, or set GITHUB_TOKEN.`
      : "No GitHub token: set GITHUB_TOKEN, sign in with GitHub, or run `gh auth login`.",
  );
}

/** `gh auth token [--user]`: the gh CLI's token for that account (or its active one), if it has one. */
export async function ghAccountToken(user?: string): Promise<string | undefined> {
  try {
    const { stdout } = await exec("gh", ["auth", "token", ...(user ? ["--user", user] : [])], { windowsHide: true });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function octokit(token: string): Octokit {
  return new Octokit({ auth: token, userAgent: "elevate/0.1" });
}

export async function getOctokit(db?: DB): Promise<Octokit> {
  return octokit(await resolveGitHubToken(db));
}
