import { HashingEmbedder } from "@elevate/agent";
import { auditLog, createDb, enqueue, eq, recommendations, repos, setSetting, swarms, swarmTasks, techniques } from "@elevate/db";
import { FakeGitHub } from "@elevate/executors";
import { replay } from "@elevate/policy";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityGraph,
  ApprovalError,
  applyEvent,
  approveRecommendation,
  closeSwarmPr,
  resumeSwarms,
  demoLLM,
  discoveryFeed,
  drain,
  LifecycleError,
  listSwarms,
  mergeSwarmPr,
  planToTasks,
  prNextStep,
  regateRecommendation,
  rejectRecommendation,
  seedDemo,
  stats,
  chat,
  createThread,
  listRecommendations,
  radar,
  threadMessages,
  trackPullRequests,
  type Ctx,
  type SwarmPr,
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
    const busy = await activityGraph(ctx);
    expect(busy.repos[0]).toMatchObject({ fullName: r!.repo, state: "working" });
    expect(busy.links.find((l) => l.id === r!.rec.id)?.status).toBe("approved");
    await drain(ctx);
    const idle = (await activityGraph(ctx)).repos.find((x) => x.fullName === r!.repo);
    expect(idle).toMatchObject({ state: expect.not.stringMatching("working"), prs: 1 });
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

  it("a repo turned off leaves the map, the inbox and the counts, and comes back when turned on", async () => {
    const before = await stats(ctx);
    const { rec, repo } = (await recs())[0]!;
    const setWatch = (watch: boolean) => ctx.db.update(repos).set({ watch }).where(eq(repos.id, rec.repoId));
    await setWatch(false);
    try {
      const s = await stats(ctx);
      const shown = await listRecommendations(ctx);
      expect(s.repos).toBe(before.repos - 1);
      expect(shown.some((r) => r.repoId === rec.repoId)).toBe(false);
      expect(s.prs).toBe(shown.filter((r) => r.status === "pr_opened").length);
      expect(s.gatedOut).toBe(shown.filter((r) => r.status === "gated_out").length);
      const graph = await activityGraph(ctx);
      expect(graph.repos.some((r) => r.id === rec.repoId)).toBe(false);
      expect(graph.links.some((l) => l.repoId === rec.repoId)).toBe(false);
      expect((await radar(ctx)).some((t) => t.foundFor.includes(repo))).toBe(false);
    } finally {
      await setWatch(true);
    }
    expect(await stats(ctx)).toEqual(before);
    expect((await activityGraph(ctx)).repos.some((r) => r.id === rec.repoId)).toBe(true);
  });

  it("Gate 2 waits while a repo is off", async () => {
    const [r] = (await recs()).filter((x) => x.rec.status === "open");
    expect(r, "demo should leave an open recommendation").toBeDefined();
    if (!r) return;
    const setWatch = (watch: boolean) => ctx.db.update(repos).set({ watch }).where(eq(repos.id, r.rec.repoId));
    await setWatch(false);
    try {
      await regateRecommendation(ctx, r.rec.id);
      await drain(ctx);
      expect((await recById(r.rec.id)).status).toBe("candidate");
    } finally {
      await setWatch(true);
    }
    await enqueue(ctx.db, "recommendation.soundness", { recommendationId: r.rec.id });
    await drain(ctx);
    expect((await recById(r.rec.id)).history.slice(-2)).toEqual(["regate", "gate_pass"]);
  });

  it("the filtered discovery feed never surfaces hype or irrelevant items; the full feed keeps them", async () => {
    const all = await discoveryFeed(ctx, { limit: 200 });
    expect(all.some((i) => i.legit === false)).toBe(true);
    const shown = await discoveryFeed(ctx, { limit: 200, hideHype: true });
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.some((i) => i.legit === false || i.status === "irrelevant" || /weight-space/i.test(i.title))).toBe(false);
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

describe("swarms survive a restart", () => {
  it("a resumed swarm follows its existing PR, publishes it as you, and opens nothing new", async () => {
    const [r] = (await recs()).filter((x) => x.rec.status === "open");
    expect(r, "demo should leave an open recommendation").toBeDefined();
    if (!r) return;
    const swarm = await approveRecommendation(ctx, r.rec.id, { executor: "copilot-cloud", allowRepo: true });
    // The worker died after Copilot opened its PR: the swarm row and tasks say "running".
    await applyEvent(ctx.db, r.rec.id, "start", {}, "test");
    await github.assignAgent(r.repo, 99);
    const [agentPr] = await github.linkedPrs(r.repo, 99);
    await ctx.db
      .update(swarms)
      .set({ status: "running", branch: "elevate/resumed", issueUrl: `https://github.com/${r.repo}/issues/99`, prUrl: agentPr!.url, startedAt: new Date() })
      .where(eq(swarms.id, swarm.id));
    await ctx.db.insert(swarmTasks).values([
      { swarmId: swarm.id, key: "plan", role: "planner", title: "Plan", instructions: "", dependsOn: [], status: "done" },
      { swarmId: swarm.id, key: "impl", role: "implementer", title: "Impl", instructions: "", dependsOn: ["plan"], status: "running" },
    ]);
    await drain(ctx);
    const before = github.writes.length;

    expect(await resumeSwarms(ctx)).toBe(1);
    await drain(ctx);

    const [done] = await ctx.db.select().from(swarms).where(eq(swarms.id, swarm.id));
    expect(done?.status).toBe("succeeded");
    expect(github.writes.slice(before).map((w) => w.op)).toEqual(["squashPr", "openDraftPr", "comment", "closePr"]);
    expect(done?.prUrl).not.toBe(agentPr!.url);
    expect(done?.result).toMatchObject({ resumed: true });
    const tasks = await ctx.db.select().from(swarmTasks).where(eq(swarmTasks.swarmId, swarm.id));
    expect(tasks.every((t) => t.status === "done")).toBe(true);
    const after = await recById(r.rec.id);
    expect(after.status).toBe("pr_opened");
    expect(after.history.slice(-2)).toEqual(["start", "pr"]);
  });
});

describe("following and merging the swarm's PR (M1–M3, T5)", () => {
  let copies = 0;
  const prNo = (url: string) => Number(/\/pull\/(\d+)/.exec(url)![1]);
  const row = async (id: string) => (await listSwarms(ctx)).find((s) => s.id === id)!;
  const setAutoMerge = (on: boolean) => setSetting(ctx.db, "swarm.autoMerge", on);
  const merges = (pr: number) => github.writes.filter((w) => w.op === "mergePr" && w.detail.pr === pr);
  const check = (name: string, state: "passed" | "failing" | "pending") => ({ name, state, url: null });
  const scheduledPass = async () => {
    await enqueue(ctx.db, "prs.track", { scheduled: true });
    await drain(ctx);
  };

  /** Approve a fresh recommendation (a copy, under a new technique, of one that passed Gate 2) and let its swarm open a PR. */
  async function openPr() {
    const src = (await ctx.db.select().from(recommendations)).find((r) => r.gate2?.passed);
    const [tech] = await ctx.db.select().from(techniques).where(eq(techniques.id, src!.techniqueId));
    const n = ++copies;
    const { id: _t, ...t } = tech!;
    const [copy] = await ctx.db.insert(techniques).values({ ...t, slug: `${t.slug}-pr-${n}`, name: `${t.name} ${n}` }).returning();
    const { id: _r, ...r } = src!;
    const [rec] = await ctx.db.insert(recommendations).values({ ...r, techniqueId: copy!.id, status: "open", history: ["gate_pass"], decidedAt: null }).returning();
    const swarm = await approveRecommendation(ctx, rec!.id, { executor: "fake", allowRepo: true });
    await drain(ctx);
    return row(swarm.id);
  }

  afterEach(() => setAutoMerge(false));

  it("follows the PR as soon as the swarm opens it, and waits for you while auto-merge is off", async () => {
    const s = await openPr();
    expect(s.status).toBe("succeeded");
    expect(s.pr).toMatchObject({ state: "open", draft: true, verified: true, passed: 1, blocking: 0 });
    expect(s.next).toMatchObject({ stage: "ready", actions: ["merge", "close", "refresh"] });
    await scheduledPass();
    expect(merges(prNo(s.prUrl!))).toEqual([]);
    expect((await recById(s.recommendationId)).status).toBe("pr_opened");
  });

  it("never merges a PR that isn't verified, even with auto-merge on, and says what it waits on (M3)", async () => {
    const s = await openPr();
    const n = prNo(s.prUrl!);
    await setAutoMerge(true);
    const stageWhen = async (state: NonNullable<ReturnType<typeof github.prStates.get>>) => {
      github.prStates.set(n, state);
      await trackPullRequests(ctx, { swarmId: s.id });
      return (await row(s.id)).next!;
    };
    expect(await stageWhen({ checks: [check("ci", "failing"), check("lint", "passed")] })).toMatchObject({ stage: "failing", tone: "danger", actions: ["refresh", "close"] });
    await expect(mergeSwarmPr(ctx, s.id)).rejects.toThrow(`Not merging PR #${n}: ci failed.`);
    expect(await stageWhen({ checks: [check("ci", "pending"), check("lint", "passed")] })).toMatchObject({ stage: "running" });
    expect(await stageWhen({ checks: [] })).toMatchObject({ stage: "no_checks" });
    expect(await stageWhen({ checks: [], awaitingApproval: 1 })).toMatchObject({ stage: "approval" });
    expect(await stageWhen({ mergeable: false, mergeableState: "dirty" })).toMatchObject({ stage: "unmergeable", short: "conflicts" });
    const setAllow = (allowSwarm: boolean) => ctx.db.update(repos).set({ allowSwarm }).where(eq(repos.fullName, s.repo));
    await setAllow(false);
    try {
      expect(await stageWhen({})).toMatchObject({ stage: "repo_off" });
      await expect(mergeSwarmPr(ctx, s.id)).rejects.toThrow(`swarms are off for ${s.repo}`);
    } finally {
      await setAllow(true);
    }
    expect(merges(n)).toEqual([]);
    expect((await recById(s.recommendationId)).status).toBe("pr_opened");
  });

  it("with auto-merge on, merges a verified PR on its own: squash at the commit it checked, branch deleted, recorded (T5)", async () => {
    const s = await openPr();
    const n = prNo(s.prUrl!);
    await setAutoMerge(true);
    expect((await row(s.id)).next).toMatchObject({ stage: "merging" });
    await scheduledPass();
    expect(merges(n)).toEqual([{ op: "mergePr", fullName: s.repo, detail: { pr: n, sha: `head${n}`, deleteBranch: s.pr!.headRef } }]);
    const done = await row(s.id);
    expect(done.pr).toMatchObject({ state: "merged", merge: { by: "auto-merge", method: "squash", branchDeleted: true } });
    expect(done.next).toMatchObject({ stage: "merged", actions: [] });
    const rec = await recById(s.recommendationId);
    expect(rec.status).toBe("merged");
    expect(rec.history.slice(-4)).toEqual(["approve", "start", "pr", "merge"]);
    expect(replay(rec.history)).toBe("merged");
    const audits = await ctx.db.select().from(auditLog).where(eq(auditLog.actor, `swarm:${s.id}`));
    expect(audits.map((a) => a.action)).toContain("github.merge_pr");
    await scheduledPass();
    expect(merges(n)).toHaveLength(1);
    await expect(mergeSwarmPr(ctx, s.id)).rejects.toBeInstanceOf(ApprovalError);
  });

  it("if GitHub refuses the merge, says why and auto-merge doesn't retry that commit; Merge tries again", async () => {
    const s = await openPr();
    const n = prNo(s.prUrl!);
    await setAutoMerge(true);
    const refuse = vi.spyOn(github, "mergePr").mockRejectedValue(Object.assign(new Error('Required status check "build" is expected.'), { status: 405 }));
    try {
      await trackPullRequests(ctx, { swarmId: s.id });
      await trackPullRequests(ctx, { swarmId: s.id });
      expect(refuse).toHaveBeenCalledTimes(1);
      const r = await row(s.id);
      expect(r.next).toMatchObject({ stage: "refused", actions: ["merge", "refresh", "close"] });
      expect(r.next!.detail).toContain('Required status check "build" is expected');
      await expect(mergeSwarmPr(ctx, s.id)).rejects.toThrow(`GitHub refused to merge PR #${n}: Required status check "build" is expected.`);
      expect((await recById(s.recommendationId)).status).toBe("pr_opened");
    } finally {
      refuse.mockRestore();
    }
    const pr = await mergeSwarmPr(ctx, s.id);
    expect(pr).toMatchObject({ state: "merged", merge: { by: "you" } });
    expect(pr.refused).toBeUndefined();
    expect((await recById(s.recommendationId)).status).toBe("merged");
  });

  it("follows the PR on GitHub: closed, reopened, then merged there", async () => {
    const s = await openPr();
    const n = prNo(s.prUrl!);
    github.prStates.set(n, { state: "closed" });
    await scheduledPass();
    expect((await recById(s.recommendationId)).status).toBe("closed");
    expect((await row(s.id)).next).toMatchObject({ stage: "closed", actions: ["reverify"] });
    await expect(mergeSwarmPr(ctx, s.id)).rejects.toThrow("Only an open PR can be merged");
    github.prStates.set(n, { state: "open" });
    await scheduledPass();
    expect((await row(s.id)).next?.stage).toBe("ready");
    github.prStates.set(n, { state: "merged", mergedAt: new Date().toISOString() });
    await scheduledPass();
    const rec = await recById(s.recommendationId);
    expect(rec.status).toBe("merged");
    expect(rec.history.slice(-4)).toEqual(["pr", "close", "pr", "merge"]);
    expect(replay(rec.history)).toBe("merged");
    expect((await row(s.id)).next).toMatchObject({ stage: "merged", detail: expect.stringContaining("merged on GitHub") });
    expect(merges(n)).toEqual([]);
  });

  it("Close keeps the branch; Re-verify starts over and the new swarm's PR supersedes the old one", async () => {
    const s = await openPr();
    const n = prNo(s.prUrl!);
    const before = github.writes.length;
    await closeSwarmPr(ctx, s.id);
    expect(github.writes.slice(before)).toEqual([{ op: "closePr", fullName: s.repo, detail: { pr: n } }]);
    expect((await recById(s.recommendationId)).status).toBe("closed");
    expect((await row(s.id)).next).toMatchObject({ stage: "closed", actions: ["reverify"] });

    await regateRecommendation(ctx, s.recommendationId);
    await drain(ctx);
    expect((await recById(s.recommendationId)).status).toBe("open");
    const again = await approveRecommendation(ctx, s.recommendationId, { executor: "fake" });
    await drain(ctx);
    expect((await row(again.id)).next?.stage).toBe("ready");
    expect((await row(s.id)).next?.stage).toBe("superseded");
    await expect(mergeSwarmPr(ctx, s.id)).rejects.toThrow("A newer swarm owns");
    expect((await recById(s.recommendationId)).history.slice(-7)).toEqual(["pr", "close", "reopen", "gate_pass", "approve", "start", "pr"]);
  });

  it("every stage names a next step", () => {
    const pr: SwarmPr = {
      number: 1,
      url: "https://github.com/o/r/pull/1",
      title: "t",
      state: "open",
      draft: true,
      mergeable: true,
      mergeableState: "draft",
      headSha: "h",
      headRef: "elevate/x",
      baseRef: "main",
      sameRepoHead: true,
      checks: [check("ci", "passed")],
      passed: 1,
      blocking: 0,
      awaitingApproval: 0,
      mergedAt: null,
      closedAt: null,
      verified: true,
      checkedAt: new Date().toISOString(),
    };
    const stage = (o: Partial<Parameters<typeof prNextStep>[1]> = {}, p: SwarmPr | null = pr) =>
      prNextStep(p ?? undefined, { recStatus: "pr_opened", allowSwarm: true, autoMerge: false, ...o });
    expect(stage({ owns: false }).stage).toBe("superseded");
    expect(stage({ recStatus: "in_progress" }).stage).toBe("detached");
    expect(stage({}, null)).toMatchObject({ stage: "unchecked", actions: ["refresh", "close"] });
    expect(stage({ allowSwarm: false }).stage).toBe("repo_off");
    expect(stage()).toMatchObject({ stage: "ready", actions: ["merge", "close", "refresh"] });
    expect(stage({ autoMerge: true }).stage).toBe("merging");
    expect(stage({}, { ...pr, refused: { sha: "h", error: "Base branch was modified", at: "" } }).stage).toBe("refused");
    expect(stage({ recStatus: "closed" }, { ...pr, state: "closed" })).toMatchObject({ stage: "closed", actions: ["reverify"] });
    expect(stage({ recStatus: "merged" }).stage).toBe("merged");
    for (const s of [stage(), stage({ autoMerge: true }), stage({}, null), stage({ allowSwarm: false })]) {
      expect(s.title.length * s.detail.length).toBeGreaterThan(0);
    }
  });
});
