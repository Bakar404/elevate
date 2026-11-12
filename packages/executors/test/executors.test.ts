import { copilotWorkFromEvents, summarizeChecks, type PrStatus } from "@elevate/github";
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
    await expect(github.authorize("merge_pr", "Bakar404/demo")).rejects.toMatchObject({ verdict: "not_approved" });
    await expect(github.mergePr("Bakar404/demo", 1, { consent: true })).rejects.toMatchObject({ verdict: "not_approved" });
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

  it("Copilot: waits for the agent to finish its work, not just for the WIP PR to appear", async () => {
    const { fake, run, tasks } = setup({ status: "in_progress", allowSwarm: true });
    fake.agentStates = ["working", "working", "finished"];
    const seen: string[] = [];
    run.setTask = async (k, s) => {
      tasks[k] = s;
      seen.push(`${k}:${s}`);
    };
    await new CopilotCloudExecutor().run(run);
    expect(fake.agentStates).toEqual([]);
    expect(tasks.impl).toBe("done");
    expect(seen.indexOf("impl:done")).toBeGreaterThan(seen.indexOf("plan:done"));
  });

  it("Copilot: fails the swarm when the agent reports a failed session", async () => {
    const { fake, run, tasks } = setup({ status: "in_progress", allowSwarm: true });
    fake.agentStates = ["working", "failed"];
    await expect(new CopilotCloudExecutor().run(run)).rejects.toThrow(/did not finish/);
    expect(tasks.impl).toBe("failed");
  });

  it("Copilot: passes the configured coding-agent model and reports it", async () => {
    const { fake, run } = setup({ status: "in_progress", allowSwarm: true });
    const out = await new CopilotCloudExecutor({ model: "claude-sonnet-5.5" }).run(run);
    expect(fake.writes[1]!.detail).toMatchObject({ model: "claude-sonnet-5.5" });
    expect(out.models).toMatchObject({ codingAgent: "claude-sonnet-5.5" });
    const auto = await new CopilotCloudExecutor().run(setup({ status: "in_progress", allowSwarm: true }).run);
    expect(auto.models?.codingAgent).toMatch(/auto/);
  });
});

describe("following a swarm across restarts", () => {
  it("Copilot reports the issue, then the PR, as soon as each exists", async () => {
    const { run } = setup({ status: "in_progress", allowSwarm: true });
    const linked: { issueUrl: string; prUrl?: string }[] = [];
    run.onLinked = async (l) => void linked.push(l);
    await new CopilotCloudExecutor().run(run);
    expect(linked).toEqual([
      { issueUrl: "https://github.com/Bakar404/demo/issues/1" },
      { issueUrl: "https://github.com/Bakar404/demo/issues/1", prUrl: "https://github.com/Bakar404/demo/pull/2" },
    ]);
  });

  it("resume follows the existing PR without writing anything", async () => {
    const { fake, run, tasks } = setup({ status: "in_progress", allowSwarm: true });
    await fake.assignAgent("Bakar404/demo", 1);
    fake.writes.length = 0;
    fake.agentStates = ["working", "finished"];
    const out = await new CopilotCloudExecutor().resume!(run, {
      issueUrl: "https://github.com/Bakar404/demo/issues/1",
      prUrl: "https://github.com/Bakar404/demo/pull/1",
    });
    expect(fake.writes).toEqual([]);
    expect(fake.agentStates).toEqual([]);
    expect(out.prUrl).toBe("https://github.com/Bakar404/demo/pull/1");
    expect(tasks.impl).toBe("done");
  });

  it("resume with only the issue finds the PR Copilot linked to it", async () => {
    const { fake, run } = setup({ status: "in_progress", allowSwarm: true });
    await fake.assignAgent("Bakar404/demo", 7);
    fake.writes.length = 0;
    const out = await new CopilotCloudExecutor().resume!(run, { issueUrl: "https://github.com/Bakar404/demo/issues/7" });
    expect(out.prUrl).toBe("https://github.com/Bakar404/demo/pull/1");
    expect(fake.writes).toEqual([]);
  });
});

describe("publish swarm PRs as you", () => {
  it("squashes the agent's branch onto the swarm branch, opens the draft PR as you, and closes the agent's PR", async () => {
    const { fake, run } = setup({ status: "in_progress", allowSwarm: true });
    const out = await new CopilotCloudExecutor({ publishAsUser: true }).run(run);
    expect(fake.writes.map((w) => w.op)).toEqual(["createIssue", "assignAgent", "squashPr", "openDraftPr", "comment", "closePr"]);
    const [, , squash, open, note, close] = fake.writes;
    expect(squash!.detail).toMatchObject({ pr: 2, branch: "elevate/add-pbt" });
    expect(squash!.detail.message).toMatch(/^Add property-based tests\n/);
    expect(squash!.detail.message).not.toMatch(/Co-authored-by|copilot/i);
    expect(open!.detail).toMatchObject({ head: "elevate/add-pbt", base: "main", title: "Add property-based tests" });
    expect(String(open!.detail.body)).toContain("Closes #1");
    expect(String(open!.detail.body)).not.toMatch(/\[WIP\]|COPILOT CODING AGENT TIPS/);
    expect(note!.detail).toMatchObject({ issue: 2 });
    expect(close!.detail).toMatchObject({ pr: 2 });
    expect(out.prUrl).toBe(`https://github.com/Bakar404/demo/pull/${open!.detail.number}`);
  });

  it("keeps the agent's PR when republishing fails", async () => {
    const { fake, run } = setup({ status: "in_progress", allowSwarm: true });
    fake.failSquash = true;
    const warnings: string[] = [];
    run.log = async (m, level) => void (level === "warn" && warnings.push(m));
    const out = await new CopilotCloudExecutor({ publishAsUser: true }).run(run);
    expect(out.prUrl).toBe("https://github.com/Bakar404/demo/pull/2");
    expect(fake.writes.map((w) => w.op)).not.toContain("closePr");
    expect(warnings.join(" ")).toMatch(/kept Copilot's pull request/i);
  });

  it("the guard refuses squashing onto the default branch and closing the swarm's PR without your consent", async () => {
    const { fake, github } = setup({ status: "in_progress", allowSwarm: true });
    await expect(github.squashPr("Bakar404/demo", 2, { branch: "main", message: "m" })).rejects.toMatchObject({ verdict: "forbidden" });
    const refused = setup({ status: "pr_opened", allowSwarm: true });
    await expect(refused.github.closePr("Bakar404/demo", 2)).rejects.toMatchObject({ verdict: "no_consent" });
    expect([...fake.writes, ...refused.fake.writes]).toEqual([]);
  });
});

describe("merging the swarm's PR (M1–M3)", () => {
  const passed = { name: "ci", state: "passed" as const, url: null };

  it("merges an open PR you consented to at the commit it checked, then deletes its branch", async () => {
    const { fake, github, audits } = setup({ status: "pr_opened", allowSwarm: true });
    const pr = await fake.openDraftPr("Bakar404/demo", { head: "elevate/add-pbt", base: "main", title: "t" });
    const out = await github.mergePr("Bakar404/demo", pr.number, { consent: true });
    expect(out).toMatchObject({ method: "squash", branchDeleted: true, status: { headSha: `head${pr.number}` } });
    expect(fake.writes.at(-1)).toMatchObject({ op: "mergePr", detail: { pr: pr.number, sha: `head${pr.number}`, deleteBranch: "elevate/add-pbt" } });
    expect(audits.at(-1)).toMatchObject({ action: "merge_pr", verdict: "allow" });
  });

  it("refuses without consent, without a passing check, with a failing or pending check, or with conflicts", async () => {
    const cases: [Partial<PrStatus>, boolean, string][] = [
      [{}, false, "no_consent"],
      [{ checks: [] }, true, "not_verified"],
      [{ checks: [passed, { name: "lint", state: "failing", url: null }] }, true, "not_verified"],
      [{ checks: [passed, { name: "proof", state: "pending", url: null }] }, true, "not_verified"],
      [{ checks: [passed, { name: "skipped", state: "neutral", url: null }], mergeable: false, mergeableState: "dirty" }, true, "not_verified"],
    ];
    for (const [status, consent, verdict] of cases) {
      const { fake, github } = setup({ status: "pr_opened", allowSwarm: true });
      fake.prStates.set(7, status);
      await expect(github.mergePr("Bakar404/demo", 7, { consent })).rejects.toMatchObject({ verdict });
      expect(fake.writes).toEqual([]);
    }
  });

  it("still needs the repo allowed and the PR in the swarm's repo", async () => {
    const off = setup({ status: "pr_opened", allowSwarm: false });
    await expect(off.github.mergePr("Bakar404/demo", 7, { consent: true })).rejects.toMatchObject({ verdict: "repo_not_allowed" });
    const on = setup({ status: "pr_opened", allowSwarm: true });
    await expect(on.github.mergePr("someone/else", 7, { consent: true })).rejects.toMatchObject({ verdict: "wrong_repo" });
    await expect(on.github.closePr("Bakar404/demo", 7, { consent: true })).resolves.toBeUndefined();
    expect(on.fake.writes.map((w) => w.op)).toEqual(["closePr"]);
  });

  it("never deletes the default branch or a fork's branch", async () => {
    const { fake, github } = setup({ status: "pr_opened", allowSwarm: true });
    fake.prStates.set(7, { headRef: "main" });
    fake.prStates.set(8, { headRef: "feature", sameRepoHead: false });
    await github.mergePr("Bakar404/demo", 7, { consent: true });
    await github.mergePr("Bakar404/demo", 8, { consent: true });
    expect(fake.writes.map((w) => w.detail.deleteBranch)).toEqual([undefined, undefined]);
  });
});

describe("summarizeChecks", () => {
  it("keeps the latest run per check name, counts skipped as neutral, and blocks on failing or unfinished checks", () => {
    const run = (id: number, name: string, status: string, conclusion: string | null) => ({ id, name, status, conclusion, html_url: null });
    const s = summarizeChecks(
      [run(1, "proof", "completed", "skipped"), run(3, "proof", "completed", "success"), run(2, "check", "completed", "success"), run(4, "lint", "completed", "skipped")],
      [],
    );
    expect(s.checks.map((c) => `${c.name}:${c.state}`)).toEqual(["check:passed", "lint:neutral", "proof:passed"]);
    expect(s).toMatchObject({ passed: 2, blocking: 0 });
    const failing = summarizeChecks([run(5, "check", "completed", "success"), run(6, "e2e", "in_progress", null)], [
      { context: "deploy", state: "failure", target_url: "https://x" },
    ]);
    expect(failing).toMatchObject({ passed: 1, blocking: 2 });
    expect(summarizeChecks([run(7, "a", "completed", "timed_out"), run(8, "b", "completed", "cancelled")], []).blocking).toBe(2);
  });
});

describe("copilotWorkFromEvents", () => {
  it("reads the PR timeline: working until a finished event, failed on a failure event", () => {
    expect(copilotWorkFromEvents(["assigned", "committed"])).toBe("working");
    expect(copilotWorkFromEvents(["copilot_work_started", "committed"])).toBe("working");
    expect(copilotWorkFromEvents(["copilot_work_started", "copilot_work_finished"])).toBe("finished");
    expect(copilotWorkFromEvents(["copilot_work_started", "copilot_work_finished_failure"])).toBe("failed");
    expect(copilotWorkFromEvents(["copilot_work_started", "copilot_work_finished", "copilot_work_started"])).toBe("working");
  });
});

describe("topoOrder", () => {
  it("orders by dependency and rejects cycles and unknown deps", () => {
    expect(topoOrder([...plan.tasks].reverse()).map((t) => t.key)).toEqual(["plan", "impl", "test", "review"]);
    expect(() => topoOrder([{ key: "a", dependsOn: ["b"] }, { key: "b", dependsOn: ["a"] }])).toThrow(/cycle/);
    expect(() => topoOrder([{ key: "a", dependsOn: ["z"] }])).toThrow(/unknown/);
  });
});
