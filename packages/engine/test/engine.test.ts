import { HashingEmbedder } from "@elevate/agent";
import { auditLog, createDb, eq, recommendations, repos, swarms, swarmTasks, techniques } from "@elevate/db";
import { FakeGitHub } from "@elevate/executors";
import { replay } from "@elevate/policy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ApprovalError,
  approveRecommendation,
  demoLLM,
  drain,
  LifecycleError,
  planToTasks,
  regateRecommendation,
  rejectRecommendation,
  seedDemo,
  stats,
  chat,
  createThread,
  listRecommendations,
  radar,
  threadMessages,
  type Ctx,
} from "../src";

const handle = createDb({ memory: true });
const github = new FakeGitHub();
let ctx: Ctx;

beforeAll(async () => {
  await handle.ready;
  ctx = {
    db: handle.db,
    demo: true,
    llm: demoLLM(),
    embedder: new HashingEmbedder(),
    github: () => Promise.reject(new Error("offline")),
    writer: async () => github,
    token: async () => "t",
    fetcher: async () => {
      throw new Error("offline");
    },
  };
  await seedDemo(ctx);
  await drain(ctx);
}, 120_000);

afterAll(() => handle.close());

const recs = () =>
  ctx.db
    .select({ rec: recommendations, repo: repos.fullName, tech: techniques.name })
    .from(recommendations)
    .innerJoin(repos, eq(recommendations.repoId, repos.id))
    .innerJoin(techniques, eq(recommendations.techniqueId, techniques.id));
const recById = async (id: string) => (await ctx.db.select().from(recommendations).where(eq(recommendations.id, id)))[0]!;

describe("pipeline on the demo workspace", () => {
  it("passes credible techniques through Gate 1 and stops hype", async () => {
    const techs = await ctx.db.select().from(techniques);
    expect(techs.some((t) => /Series B/.test(t.name))).toBe(false);
    expect(techs.find((t) => /proof-driven/i.test(t.name))?.legitimacy?.passed).toBe(true);
    const hype = techs.find((t) => /weight-space/i.test(t.name));
    expect(hype?.legitimacy?.passed).toBe(false);
    expect((await recs()).some((r) => r.rec.techniqueId === hype?.id)).toBe(false);
  });

  it("only recommendations that passed both gates reach the inbox; every status replays from its history (T7)", async () => {
    const all = await recs();
    const open = all.filter((r) => r.rec.status === "open");
    expect(open.length).toBeGreaterThan(0);
    for (const { rec } of all) {
      expect(replay(rec.history)).toBe(rec.status);
      if (rec.status === "open") expect(rec.gate1?.passed && rec.gate2?.passed).toBe(true);
    }
    expect(open.some((r) => /proof-driven/i.test(r.tech) && r.repo === "demo/ledger-api")).toBe(true);
    const offDomain = all.find((r) => /speculative/i.test(r.tech) && r.repo === "demo/ledger-api");
    if (offDomain) expect(offDomain.rec.status).toBe("gated_out");
  });
});

describe("approval and swarm", () => {
  it("refuses to approve on a repo that hasn't opted in", async () => {
    const [r] = (await recs()).filter((x) => x.rec.status === "open");
    await expect(approveRecommendation(ctx, r!.rec.id, { executor: "fake" })).rejects.toBeInstanceOf(ApprovalError);
    expect((await recById(r!.rec.id)).status).toBe("open");
  });

  it("approve → swarm → draft PR, with every write audited", async () => {
    const [r] = (await recs()).filter((x) => x.rec.status === "open");
    const swarm = await approveRecommendation(ctx, r!.rec.id, { executor: "fake", allowRepo: true });
    await drain(ctx);
    const [done] = await ctx.db.select().from(swarms).where(eq(swarms.id, swarm.id));
    expect(done?.status).toBe("succeeded");
    expect(done?.prUrl).toContain("/pull/");
    const after = await recById(r!.rec.id);
    expect(after.status).toBe("pr_opened");
    expect(after.history.slice(-3)).toEqual(["approve", "start", "pr"]);
    expect(github.writes.map((w) => w.op)).toContain("openDraftPr");
    expect(github.writes.every((w) => w.fullName === r!.repo)).toBe(true);
    const tasks = await ctx.db.select().from(swarmTasks).where(eq(swarmTasks.swarmId, swarm.id));
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks.every((t) => t.status === "done")).toBe(true);
    const audits = await ctx.db.select().from(auditLog);
    expect(audits.filter((a) => a.target === r!.repo).length).toBeGreaterThanOrEqual(github.writes.length);
  });

  it("a recommendation with an open PR can't be approved or rejected again (T5)", async () => {
    const [done] = (await recs()).filter((x) => x.rec.status === "pr_opened");
    await expect(approveRecommendation(ctx, done!.rec.id, { executor: "fake" })).rejects.toBeInstanceOf(LifecycleError);
    await expect(rejectRecommendation(ctx, done!.rec.id)).rejects.toBeInstanceOf(LifecycleError);
  });

  it("reopening a rejected recommendation sends it back through Gate 2, not straight to the inbox (T6)", async () => {
    const [r] = (await recs()).filter((x) => x.rec.status === "open");
    expect(r, "demo should leave a second open recommendation").toBeDefined();
    if (!r) return;
    await rejectRecommendation(ctx, r.rec.id);
    await regateRecommendation(ctx, r.rec.id);
    expect((await recById(r.rec.id)).status).toBe("candidate");
    await drain(ctx);
    const after = await recById(r.rec.id);
    expect(after.history.slice(-3)).toEqual(["reject", "reopen", "gate_pass"]);
    expect(replay(after.history)).toBe(after.status);
  });
});

describe("read models and chat", () => {
  it("stats agree with the rows", async () => {
    const s = await stats(ctx);
    const all = await recs();
    expect(s.repos).toBe(3);
    expect(s.open).toBe(all.filter((r) => r.rec.status === "open").length);
    expect(s.prs).toBe(1);
    expect(s.hype).toBeGreaterThanOrEqual(1);
    expect((await listRecommendations(ctx, "open")).every((r) => r.status === "open")).toBe(true);
    const hype = (await radar(ctx)).find((t) => /weight-space/i.test(t.name));
    expect(hype?.items[0]?.source).toBe("Growth Hacks Weekly");
  });

  it("demo chat answers from the real tools and saves both messages", async () => {
    const thread = await createThread(ctx);
    const seen: string[] = [];
    const text = await chat(ctx, thread.id, "what should I upgrade?", (e) => seen.push(e.type));
    expect(seen).toEqual(expect.arrayContaining(["tool_start", "tool_end", "delta", "done"]));
    expect(text).toMatch(/ledger-api|llm-router/);
    const msgs = await threadMessages(ctx, thread.id);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1]?.toolCalls[0]?.name).toBe("list_recommendations");
  });
});

describe("planToTasks", () => {
  it("drops invented and forward dependencies and de-duplicates keys", () => {
    const tasks = planToTasks({
      verification: "pnpm test",
      subtasks: [
        { key: "a", title: "A", instructions: "", dependsOn: ["b", "ghost"] },
        { key: "b", title: "B", instructions: "", dependsOn: ["a"] },
        { key: "a", title: "A2", instructions: "", dependsOn: [] },
        { key: "plan", title: "P", instructions: "", dependsOn: [] },
      ],
    });
    const keys = tasks.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(tasks.find((t) => t.key === "a")?.dependsOn).toEqual(["plan"]);
    expect(tasks.find((t) => t.key === "b")?.dependsOn).toEqual(["plan", "a"]);
    const idx = new Map(keys.map((k, i) => [k, i]));
    for (const t of tasks) for (const d of t.dependsOn) expect(idx.get(d)!).toBeLessThan(idx.get(t.key)!);
  });
});
