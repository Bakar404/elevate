import { CopilotLLM, defaultEmbedder, type Embedder, type LLM } from "@elevate/agent";
import { getDb, type DB } from "@elevate/db";
import { FakeGitHub, octokitWriter, type GitHubWriter } from "@elevate/executors";
import { getOctokit, resolveGitHubToken, type Octokit } from "@elevate/github";
import type { Fetcher } from "@elevate/sources";
import { demoLLM } from "./fake";

export type Ctx = {
  db: DB;
  llm: LLM;
  embedder: Embedder;
  github: () => Promise<Octokit>;
  /** Raw GitHub writer handed to `guardedGitHub`; never given to executors directly. */
  writer: () => Promise<GitHubWriter>;
  token: () => Promise<string>;
  fetcher?: Fetcher;
  /** Offline demo: fake model, fake GitHub writes, no network for evidence lookups. */
  demo: boolean;
};

export const isDemo = () => process.env.ELEVATE_DEMO === "1";

const offline: Fetcher = async () => {
  throw new Error("offline demo");
};

let octo: Promise<Octokit> | undefined;
const FAKE_GH = Symbol.for("elevate.fakeGitHub");
type G = typeof globalThis & { [FAKE_GH]?: FakeGitHub };

/** The process-wide fake GitHub used in demo mode (inspectable by tests). */
export function demoGitHub(): FakeGitHub {
  const g = globalThis as G;
  return (g[FAKE_GH] ??= new FakeGitHub());
}

export async function defaultCtx(): Promise<Ctx> {
  const db = await getDb();
  const demo = isDemo();
  const github = () => {
    if (demo) return Promise.reject(new Error("GitHub is not available in demo mode"));
    octo ??= getOctokit(db).catch((e) => {
      octo = undefined;
      throw e;
    });
    return octo;
  };
  return {
    db,
    demo,
    llm: demo || process.env.ELEVATE_FAKE_LLM ? demoLLM() : new CopilotLLM(),
    embedder: defaultEmbedder(),
    github,
    writer: async () => (demo ? demoGitHub() : octokitWriter(await github())),
    token: () => (demo ? Promise.resolve("demo") : resolveGitHubToken(db)),
    ...(demo ? { fetcher: offline } : {}),
  };
}

/** Drop the cached Octokit (e.g. after the user signs in with a different account). */
export function resetGitHubClient() {
  octo = undefined;
}
