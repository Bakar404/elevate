import { WriteRefused, type WriteAction } from "@elevate/policy";
import { describe, expect, it } from "vitest";
import {
  CopilotCloudExecutor,
  FakeExecutor,
  FakeGitHub,
  guardedGitHub,
  MentionExecutor,
  topoOrder,
  type GuardState,
  type SwarmRun,
} from "../src";

const plan: SwarmRun["plan"] = {
  summary: "Add property-based tests to the parser",
  acceptanceCriteria: ["Parser round-trips 1,000 generated inputs"],
  verification: "pnpm test",
  tasks: [
    { key: "plan", role: "planner", title: "Plan", instructions: "", dependsOn: [] },
    { key: "impl", role: "implementer", title: "Add fast-check", instructions: "Add tests", dependsOn: ["plan"] },
    { key: "test", role: "tester", title: "Run tests", instructions: "Run", dependsOn: ["impl"] },
    { key: "review", role: "reviewer", title: "Review", instructions: "Review", dependsOn: ["test"] },
  ],
};

function setup(state: GuardState, budget = { maxTasks: 5, maxMinutes: 60, maxAgentTurns: 20 }) {
  const fake = new FakeGitHub();
  const audits: { action: WriteAction; target: string; verdict: unknown }[] = [];
  const tasks: Record<string, string> = {};
  const github = guardedGitHub(fake, {
    repoFullName: "Bakar404/demo",
    defaultBranch: "main",
    budget,
    state: async () => state,
    audit: async (action, target, d) => void audits.push({ action, target, verdict: d.verdict }),
  });
  const run: SwarmRun = {
    swarmId: "s1",
    repo: { fullName: "Bakar404/demo", defaultBranch: "main" },
    recommendation: { id: "r1", title: "Add property-based tests", rationale: "r", expectedImpact: "i" },
    plan,
    branch: "elevate/add-pbt",
    github,
    token: async () => "t",
    log: async () => {},
    setTask: async (k, s) => void (tasks[k] = s),
    budgetMinutes: 1,
    pollMs: 1,
  };
  return { fake, audits, tasks, run, github };
}

describe("TB3: every GitHub write goes through the guard", () => {
  const refusing: GuardState[] = [
    { status: "open", allowSwarm: true },
    { status: "candidate", allowSwarm: true },
    { status: "approved", allowSwarm: false },
    { status: "pr_opened", allowSwarm: true },
    { status: "rejected", allowSwarm: true },
  ];
  for (const executor of [new FakeExecutor(), new CopilotCloudExecutor(), new MentionExecutor("claude-action", "Claude", "@claude")]) {
    for (const state of refusing) {
      it(`${executor.kind} writes nothing when status=${state.status}, allowSwarm=${state.allowSwarm}`, async () => {
        const { fake, audits, run } = setup(state);
        await expect(executor.run(run)).rejects.toBeInstanceOf(WriteRefused);
        expect(fake.writes).toEqual([]);
        expect(audits.length).toBeGreaterThan(0);
        expect(audits.every((a) => a.verdict !== "allow")).toBe(true);
      });
    }
  }

  it("the simulated swarm opens only a draft PR on its own branch when approved", async () => {
    const { fake, tasks, run } = setup({ status: "in_progress", allowSwarm: true });
    const out = await new FakeExecutor().run(run);
    expect(out.prUrl).toMatch(/Bakar404\/demo\/pull\/\d+/);
    expect(fake.writes.map((w) => w.op)).toEqual(["createIssue", "openDraftPr"]);
    expect(fake.writes[1]!.detail).toMatchObject({ head: "elevate/add-pbt", base: "main" });
    expect(Object.values(tasks).every((s) => s === "done")).toBe(true);
  });

  it("refuses writes to another repo, non-draft PRs, and the default branch", async () => {
    const { fake, github } = setup({ status: "in_progress", allowSwarm: true });
    await expect(github.createIssue("someone/else", "t", "b")).rejects.toMatchObject({ verdict: "wrong_repo" });
    await expect(github.openDraftPr("Bakar404/demo", { head: "x", base: "main", title: "t", body: "b", draft: false })).rejects.toMatchObject({
      verdict: "not_draft",
    });
    await expect(github.openDraftPr("Bakar404/demo", { head: "main", base: "main", title: "t", body: "b" })).rejects.toMatchObject({
      verdict: "forbidden",
    });
    await expect(github.authorizePush("Bakar404/demo", "main")).rejects.toMatchObject({ verdict: "forbidden" });
    await expect(github.authorize("merge_pr", "Bakar404/demo")).rejects.toMatchObject({ verdict: "forbidden" });
    expect(fake.writes).toEqual([]);
  });

  it("stops new agent work at the budget but still publishes (D3)", async () => {
    const { fake, run } = setup({ status: "in_progress", allowSwarm: true }, { maxTasks: 1, maxMinutes: 60, maxAgentTurns: 20 });
    await expect(new FakeExecutor().run(run)).rejects.toMatchObject({ verdict: "budget_exhausted" });
    expect(fake.writes.map((w) => w.op)).toEqual(["createIssue"]);
    await expect(run.github.openDraftPr("Bakar404/demo", { head: run.branch, base: "main", title: "t", body: "b" })).resolves.toBeTruthy();
  });

  it("re-reads state before each write, so rejecting mid-run stops the swarm", async () => {
    const state: GuardState = { status: "in_progress", allowSwarm: true };
    const { fake, github } = setup(state);
    await github.createIssue("Bakar404/demo", "t", "b");
    state.status = "rejected";
    await expect(github.comment("Bakar404/demo", 1, "x")).rejects.toMatchObject({ verdict: "not_approved" });
    expect(fake.writes).toHaveLength(1);
  });
});

describe("cloud executors", () => {
  it("Copilot: assigns the issue and returns the linked PR", async () => {
    const { fake, run } = setup({ status: "in_progress", allowSwarm: true });
    const out = await new CopilotCloudExecutor().run(run);
    expect(fake.writes.map((w) => w.op)).toEqual(["createIssue", "assignAgent"]);
    expect(out.prUrl).toContain("/pull/");
  });
});

describe("topoOrder", () => {
  it("orders by dependency and rejects cycles and unknown deps", () => {
    expect(topoOrder([...plan.tasks].reverse()).map((t) => t.key)).toEqual(["plan", "impl", "test", "review"]);
    expect(() => topoOrder([{ key: "a", dependsOn: ["b"] }, { key: "b", dependsOn: ["a"] }])).toThrow(/cycle/);
    expect(() => topoOrder([{ key: "a", dependsOn: ["z"] }])).toThrow(/unknown/);
  });
});
