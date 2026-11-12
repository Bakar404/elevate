import { describe, expect, it } from "vitest";
import { authorizeWrite, legitimacyDecision, pct, replay, soundnessDecision, type WriteRequest } from "../src/index";

describe("pct (TB4: normalization)", () => {
  it("clamps, rounds, and maps non-finite input to 0", () => {
    expect([pct(-5), pct(0), pct(49.5), pct(100), pct(250)]).toEqual([0, 0, 50, 100, 100]);
    expect([pct(Number.NaN), pct(Infinity), pct(undefined), pct("72")]).toEqual([0, 0, 0, 72]);
  });
  it("lets a float score reach the kernel as the integer the proof covers", () => {
    expect(legitimacyDecision({ prior: 59.6, review: 60.4, legit: true }).score).toBe(60);
  });
});

describe("the rules, by example", () => {
  it("a hyped technique with no independent evidence never passes Gate 1 (L5)", () => {
    expect(legitimacyDecision({ prior: 10, review: 100, legit: true })).toMatchObject({ passed: false, reason: "no_evidence" });
  });
  it("a high-risk change needs 15 more points than a low-risk one (S4)", () => {
    const base = { gate1Passed: true, sound: true, measurable: true, score: 70 };
    expect(soundnessDecision({ ...base, risk: "low" }).passed).toBe(true);
    expect(soundnessDecision({ ...base, risk: "high" })).toMatchObject({ passed: false, bar: 80 });
  });
  it("a history without approval never reaches a running swarm (T7)", () => {
    expect(replay(["gate_pass", "start"])).toBeNull();
    expect(replay(["gate_pass", "approve", "start"])).toBe("in_progress");
  });
  it("a finished swarm can still publish its draft PR after its budget runs out (W6, D3)", () => {
    const q: WriteRequest = {
      action: "open_pr",
      status: "in_progress",
      allowSwarm: true,
      sameRepo: true,
      draft: true,
      usage: { tasks: 5, minutes: 90, agentTurns: 200 },
      budget: { maxTasks: 5, maxMinutes: 60, maxAgentTurns: 200 },
    };
    expect(authorizeWrite(q)).toBe("allow");
    expect(authorizeWrite({ ...q, action: "assign_agent" })).toBe("budget_exhausted");
    expect(authorizeWrite({ ...q, action: "merge_pr" })).toBe("not_approved");
    expect(authorizeWrite({ ...q, action: "force_push" })).toBe("forbidden");
  });
  it("a swarm's PR is merged only once it is open, with your consent, and verified by its checks (M1–M3)", () => {
    const q: WriteRequest = {
      action: "merge_pr",
      status: "pr_opened",
      allowSwarm: true,
      sameRepo: true,
      draft: true,
      consent: true,
      checksPassed: 2,
      checksBlocking: 0,
      mergeable: true,
      usage: { tasks: 5, minutes: 90, agentTurns: 200 },
      budget: { maxTasks: 5, maxMinutes: 60, maxAgentTurns: 200 },
    };
    expect(authorizeWrite(q)).toBe("allow");
    expect(authorizeWrite({ ...q, status: "in_progress" })).toBe("not_approved");
    expect(authorizeWrite({ ...q, consent: false })).toBe("no_consent");
    expect(authorizeWrite({ ...q, checksPassed: 0 })).toBe("not_verified");
    expect(authorizeWrite({ ...q, checksBlocking: 1 })).toBe("not_verified");
    expect(authorizeWrite({ ...q, mergeable: false })).toBe("not_verified");
    expect(authorizeWrite({ ...q, allowSwarm: false })).toBe("repo_not_allowed");
    // Closing changes no code, so it needs your consent but not passing checks.
    expect(authorizeWrite({ ...q, action: "close_pr", checksPassed: 0, mergeable: false })).toBe("allow");
    expect(authorizeWrite({ ...q, action: "close_pr", consent: false })).toBe("no_consent");
    expect(authorizeWrite({ ...q, action: "push_branch" })).toBe("not_approved");
  });
  it("a merged PR is the end; a closed one can be reopened on GitHub or re-gated (T5, T6, T8)", () => {
    expect(replay(["gate_pass", "approve", "start", "pr", "merge"])).toBe("merged");
    expect(replay(["gate_pass", "approve", "start", "pr", "merge", "reopen"])).toBeNull();
    expect(replay(["gate_pass", "approve", "start", "pr", "close", "pr", "merge"])).toBe("merged");
    expect(replay(["gate_pass", "approve", "start", "pr", "close", "reopen"])).toBe("candidate");
    expect(replay(["gate_pass", "approve", "start", "merge"])).toBeNull();
  });
  it("an unknown action string from untyped input is forbidden", () => {
    expect(authorizeWrite({ action: "delete_repo" as never, status: "approved", allowSwarm: true, sameRepo: true, draft: true, usage: { tasks: 0, minutes: 0, agentTurns: 0 }, budget: { maxTasks: 1, maxMinutes: 1, maxAgentTurns: 1 } })).toBe("forbidden");
  });
});
