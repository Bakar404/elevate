import type { ExecutorKind, TaskRole, TaskStatus } from "@elevate/db";
import type { GuardedGitHub } from "./guard";

export type PlannedTask = {
  key: string;
  role: TaskRole;
  title: string;
  instructions: string;
  dependsOn: string[];
};

export type SwarmPlan = {
  summary: string;
  acceptanceCriteria: string[];
  verification: string;
  tasks: PlannedTask[];
};

export type SwarmRun = {
  swarmId: string;
  repo: { fullName: string; defaultBranch: string };
  recommendation: { id: string; title: string; rationale: string; expectedImpact: string };
  plan: SwarmPlan;
  /** The swarm's own branch. Never the default branch. */
  branch: string;
  /** The only way an executor can write to GitHub. Every call is authorized by the proved guard. */
  github: GuardedGitHub;
  /** Clone token for local executors (read-only use: clone and push to the swarm branch via the guard). */
  token: () => Promise<string>;
  log: (message: string, level?: "info" | "success" | "warn" | "error") => Promise<void>;
  setTask: (key: string, status: TaskStatus, output?: string) => Promise<void>;
  signal?: AbortSignal;
  /** Wall-clock limit for waiting on agents (the swarm budget's maxMinutes). */
  budgetMinutes: number;
  /** Polling cadence for cloud executors; tests use a tiny value. */
  pollMs?: number;
};

export type SwarmOutcome = {
  prUrl?: string;
  issueUrl?: string;
  summary: string;
};

export interface Executor {
  readonly kind: ExecutorKind;
  readonly label: string;
  run(run: SwarmRun): Promise<SwarmOutcome>;
}

/** Order tasks so every task comes after the tasks it depends on. Throws on cycles or unknown deps. */
export function topoOrder<T extends { key: string; dependsOn: string[] }>(tasks: T[]): T[] {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const out: T[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (t: T) => {
    const s = state.get(t.key);
    if (s === "done") return;
    if (s === "visiting") throw new Error(`Task graph has a cycle at ${t.key}`);
    state.set(t.key, "visiting");
    for (const d of t.dependsOn) {
      const dep = byKey.get(d);
      if (!dep) throw new Error(`Task ${t.key} depends on unknown task ${d}`);
      visit(dep);
    }
    state.set(t.key, "done");
    out.push(t);
  };
  tasks.forEach(visit);
  return out;
}

export function issueBody(run: Pick<SwarmRun, "recommendation" | "plan" | "branch">): string {
  const { recommendation: r, plan } = run;
  return [
    `> Opened by **elevate** after the technique passed the legitimacy gate, the change passed the soundness gate, and you approved it.`,
    ``,
    `## Why`,
    r.rationale,
    ``,
    `**Expected impact:** ${r.expectedImpact}`,
    ``,
    `## Plan`,
    plan.summary,
    ``,
    ...plan.tasks.filter((t) => t.role === "implementer" || t.role === "tester").map((t) => `- [ ] **${t.title}**: ${t.instructions}`),
    ``,
    `## Acceptance criteria`,
    ...plan.acceptanceCriteria.map((c) => `- ${c}`),
    ``,
    `## Verification`,
    plan.verification,
    ``,
    `Work on a branch and open a **draft** pull request. Do not merge.`,
  ].join("\n");
}
