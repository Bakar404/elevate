import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Octokit } from "@octokit/rest";
import { getSecret, type DB } from "@elevate/db";

const exec = promisify(execFile);

/** Resolve a GitHub token: env -> stored (OAuth) secret -> `gh auth token [--user]`. */
export async function resolveGitHubToken(db?: DB): Promise<string> {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (db) {
    const stored = await getSecret(db, "github_token").catch(() => undefined);
    if (stored) return stored;
  }
  const args = ["auth", "token"];
  if (process.env.GITHUB_USER) args.push("--user", process.env.GITHUB_USER);
  try {
    const { stdout } = await exec("gh", args, { windowsHide: true });
    const token = stdout.trim();
    if (token) return token;
  } catch {
    // fall through
  }
  throw new Error("No GitHub token: set GITHUB_TOKEN, sign in with GitHub, or run `gh auth login`.");
}

export function octokit(token: string): Octokit {
  return new Octokit({ auth: token, userAgent: "elevate/0.1" });
}

export async function getOctokit(db?: DB): Promise<Octokit> {
  return octokit(await resolveGitHubToken(db));
}
