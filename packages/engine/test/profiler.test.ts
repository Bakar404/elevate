import type { Octokit } from "@octokit/rest";
import { HashingEmbedder } from "@elevate/agent";
import { createDb, eq, jobs, repos, type RepoProfile } from "@elevate/db";
import { FakeGitHub } from "@elevate/executors";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { profileRepo, syncRepos, type Ctx } from "../src";

const handle = createDb({ memory: true });
let ctx: Ctx;

/** One remote repo whose default-branch head and pushed_at we can move. */
const remote = { head: "aaa111", pushedAt: "2026-01-01T00:00:00Z" };
let branchCalls = 0;
let profiled = 0;

const repo = () => ({
  id: 1,
  full_name: "me/app",
  owner: { login: "me" },
  name: "app",
  description: null,
  default_branch: "main",
  language: "TypeScript",
  topics: [],
  stargazers_count: 0,
  private: false,
  archived: false,
  fork: false,
  html_url: "https://github.com/me/app",
  pushed_at: remote.pushedAt,
});

const fakeOctokit = {
  paginate: async () => [repo()],
  repos: {
    listForAuthenticatedUser: async () => ({ data: [repo()] }),
    getBranch: async () => {
      branchCalls++;
      return { data: { commit: { sha: remote.head } } };
    },
    getReadme: async () => ({ data: { content: Buffer.from("# app").toString("base64") } }),
    listLanguages: async () => ({ data: {} }),
    listCommits: async () => ({ data: [] }),
    getContent: async () => ({ data: {} }),
  },
  git: { getTree: async () => ({ data: { tree: [] } }) },
} as unknown as Octokit;

const profile: RepoProfile = { summary: "s", stack: [], domains: [], keyModules: [], testSetup: "", improvementSurfaces: [] };

beforeAll(async () => {
  await handle.ready;
  const github = new FakeGitHub();
  ctx = {
    db: handle.db,
    demo: false,
    llm: {
      json: async <T>() => {
        profiled++;
        return profile as T;
      },
    } as unknown as Ctx["llm"],
    embedder: new HashingEmbedder(),
    github: async () => fakeOctokit,
    writer: async () => github,
    token: async () => "t",
  };
}, 60_000);

afterAll(() => handle.close());

const queuedProfiles = async () =>
  (await ctx.db.select().from(jobs).where(eq(jobs.type, "repo.profile"))).filter((j) => j.status === "queued");

async function profileQueued() {
  for (const j of await queuedProfiles()) {
    await profileRepo(ctx, (j.payload as { repoId: string }).repoId);
    await ctx.db.delete(jobs).where(eq(jobs.id, j.id));
  }
}

describe("repo profiling follows the default branch", () => {
  beforeEach(() => {
    branchCalls = 0;
  });

  it("profiles a new repo and records the commit it profiled", async () => {
    expect((await syncRepos(ctx)).queued).toBe(1);
    await profileQueued();
    const [row] = await ctx.db.select().from(repos);
    expect(row!.profiledSha).toBe("aaa111");
    expect(profiled).toBe(1);
  });

  it("does nothing when nothing was pushed", async () => {
    expect((await syncRepos(ctx)).queued).toBe(0);
    expect(branchCalls).toBe(0);
  });

  it("does not re-profile a push that left the default branch where it was (e.g. a feature branch)", async () => {
    remote.pushedAt = "2026-01-02T00:00:00Z";
    expect((await syncRepos(ctx)).queued).toBe(0);
    expect(branchCalls).toBe(1);
    expect((await syncRepos(ctx)).queued).toBe(0);
    expect(branchCalls).toBe(1);
  });

  it("re-profiles on every new commit to the default branch", async () => {
    for (const [i, sha] of ["bbb222", "ccc333"].entries()) {
      remote.head = sha;
      remote.pushedAt = `2026-01-0${3 + i}T00:00:00Z`;
      expect((await syncRepos(ctx)).queued).toBe(1);
      await profileQueued();
      const [row] = await ctx.db.select().from(repos);
      expect(row!.profiledSha).toBe(sha);
    }
    expect(profiled).toBe(3);
  });
});
