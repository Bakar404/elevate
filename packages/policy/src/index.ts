/**
 * elevate's policy kernel. Every rule here is a requirement in proof/intent.md,
 * proved for every input in proof/verified/src/lib.rs, and compared with the
 * proved code on every input class by test/differential.test.ts.
 *
 * Change a rule here only together with the spec, then run `pnpm proof`.
 */

/** TB4: a score from a model or heuristic, as an integer percentage. */
export function pct(x: unknown): number {
  const n = typeof x === "number" ? x : Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

export const DEFAULT_THRESHOLDS = { legitimacy: 60, priorFloor: 30, soundness: 65 } as const;
export type Thresholds = { legitimacy: number; priorFloor: number; soundness: number };

// ─── Gate 1 (L1–L6) ──────────────────────────────────────────────────────

export type LegitimacyInput = { prior: number; review: number; legit: boolean };
export type LegitimacyDecision = { passed: boolean; score: number; reason: "passed" | "vetoed" | "no_evidence" | "below_threshold" };

export function legitimacyDecision(
  input: LegitimacyInput,
  t: Pick<Thresholds, "legitimacy" | "priorFloor"> = DEFAULT_THRESHOLDS,
): LegitimacyDecision {
  const prior = pct(input.prior);
  const review = pct(input.review);
  const score = Math.floor((2 * prior + 3 * review) / 5);
  if (!input.legit) return { passed: false, score, reason: "vetoed" };
  if (prior < pct(t.priorFloor)) return { passed: false, score, reason: "no_evidence" };
  if (score < pct(t.legitimacy)) return { passed: false, score, reason: "below_threshold" };
  return { passed: true, score, reason: "passed" };
}

// ─── Gate 2 (S1–S6) ──────────────────────────────────────────────────────

export type Risk = "low" | "medium" | "high";
export const RISK_MARGIN: Record<Risk, number> = { low: 0, medium: 5, high: 15 };

export type SoundnessInput = { gate1Passed: boolean; sound: boolean; measurable: boolean; score: number; risk: Risk };
export type SoundnessDecision = {
  passed: boolean;
  bar: number;
  reason: "passed" | "gate1_failed" | "vetoed" | "not_measurable" | "below_bar";
};

export function soundnessBar(threshold: number, risk: Risk): number {
  return Math.min(100, pct(threshold) + (RISK_MARGIN[risk] ?? RISK_MARGIN.high));
}

export function soundnessDecision(input: SoundnessInput, threshold: number = DEFAULT_THRESHOLDS.soundness): SoundnessDecision {
  const bar = soundnessBar(threshold, input.risk);
  if (!input.gate1Passed) return { passed: false, bar, reason: "gate1_failed" };
  if (!input.sound) return { passed: false, bar, reason: "vetoed" };
  if (!input.measurable) return { passed: false, bar, reason: "not_measurable" };
  if (pct(input.score) < bar) return { passed: false, bar, reason: "below_bar" };
  return { passed: true, bar, reason: "passed" };
}

/** Inbox rank from relevance, legitimacy and soundness, each 0–100. */
export function recommendationScore(relevance: number, legitimacy: number, soundness: number): number {
  return Math.floor((30 * pct(relevance) + 30 * pct(legitimacy) + 40 * pct(soundness)) / 100);
}

// ─── The lifecycle (T1–T8) ───────────────────────────────────────────────

export const STATUSES = ["candidate", "gated_out", "open", "approved", "rejected", "in_progress", "pr_opened", "failed", "merged", "closed"] as const;
export type Status = (typeof STATUSES)[number];
export const EVENTS = ["gate_pass", "gate_fail", "approve", "reject", "start", "pr", "fail", "retry", "regate", "reopen", "merge", "close"] as const;
export type LifecycleEvent = (typeof EVENTS)[number];

const LIFECYCLE: Record<Status, Partial<Record<LifecycleEvent, Status>>> = {
  candidate: { gate_pass: "open", gate_fail: "gated_out" },
  gated_out: { regate: "candidate" },
  open: { approve: "approved", reject: "rejected", regate: "candidate" },
  approved: { start: "in_progress", reject: "rejected" },
  in_progress: { pr: "pr_opened", fail: "failed" },
  failed: { retry: "approved", reject: "rejected" },
  rejected: { reopen: "candidate" },
  pr_opened: { merge: "merged", close: "closed" },
  merged: {},
  // `pr`: the closed PR was reopened on GitHub.
  closed: { reopen: "candidate", pr: "pr_opened" },
};

/** The next status, or null when the event isn't allowed in this status. */
export function transition(status: Status, event: LifecycleEvent): Status | null {
  const row = Object.hasOwn(LIFECYCLE, status) ? LIFECYCLE[status] : undefined;
  return row && Object.hasOwn(row, event) ? (row[event] ?? null) : null;
}

/** Replays a history from `candidate`; null if any event is out of place. */
export function replay(events: readonly LifecycleEvent[]): Status | null {
  let status: Status = "candidate";
  for (const e of events) {
    const next = transition(status, e);
    if (next === null) return null;
    status = next;
  }
  return status;
}

export function canTransition(status: Status, event: LifecycleEvent): boolean {
  return transition(status, event) !== null;
}

// ─── The write guard (W1–W7, M1–M3) ──────────────────────────────────────

export const ACTIONS = [
  "create_issue",
  "comment",
  "assign_agent",
  "run_local_agent",
  "push_branch",
  "open_pr",
  "close_pr",
  "merge_pr",
  "push_default_branch",
  "force_push",
] as const;
export type WriteAction = (typeof ACTIONS)[number];

export const VERDICTS = [
  "allow",
  "forbidden",
  "not_approved",
  "repo_not_allowed",
  "wrong_repo",
  "not_draft",
  "budget_exhausted",
  "no_consent",
  "not_verified",
] as const;
export type Verdict = (typeof VERDICTS)[number];

export type Budget = { maxTasks: number; maxMinutes: number; maxAgentTurns: number };
export type Usage = { tasks: number; minutes: number; agentTurns: number };

export type WriteRequest = {
  action: WriteAction;
  status: Status;
  allowSwarm: boolean;
  sameRepo: boolean;
  draft: boolean;
  /** Merging or closing the swarm's open PR: you clicked it, or turned auto-merge on (M2). */
  consent?: boolean;
  /** GitHub checks on the PR's head commit that passed (M3). */
  checksPassed?: number;
  /** Checks that failed, were cancelled, or are still running (M3). */
  checksBlocking?: number;
  /** GitHub can merge the PR without conflicts (M3). */
  mergeable?: boolean;
  usage: Usage;
  budget: Budget;
};

const FORBIDDEN = new Set<WriteAction>(["push_default_branch", "force_push"]);
const SPENDS = new Set<WriteAction>(["assign_agent", "run_local_agent"]);

export function authorizeWrite(q: WriteRequest): Verdict {
  if (FORBIDDEN.has(q.action) || !ACTIONS.includes(q.action)) return "forbidden";
  const merging = q.action === "merge_pr";
  const finishing = q.status === "pr_opened" && (merging || q.action === "close_pr");
  if (!finishing) {
    if (q.status !== "approved" && q.status !== "in_progress") return "not_approved";
    if (merging) return "not_approved";
  }
  if (!q.allowSwarm) return "repo_not_allowed";
  if (!q.sameRepo) return "wrong_repo";
  if (finishing) {
    if (q.consent !== true) return "no_consent";
    if (merging && (!((q.checksPassed ?? 0) > 0) || (q.checksBlocking ?? 0) !== 0 || q.mergeable !== true)) return "not_verified";
    return "allow";
  }
  if (q.action === "open_pr" && !q.draft) return "not_draft";
  if (SPENDS.has(q.action)) {
    const { usage: u, budget: b } = q;
    if (!(u.tasks < b.maxTasks) || !(u.minutes < b.maxMinutes) || !(u.agentTurns < b.maxAgentTurns)) return "budget_exhausted";
  }
  return "allow";
}

export class WriteRefused extends Error {
  constructor(
    readonly verdict: Exclude<Verdict, "allow">,
    readonly action: WriteAction,
  ) {
    super(`Write refused (${verdict}): ${action}`);
    this.name = "WriteRefused";
  }
}
