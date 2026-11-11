import type { SwarmBudget } from "@elevate/db";
import {
  assignCopilotAgent,
  commentOnIssue,
  copilotWorkStatus,
  createIssue,
  findLinkedPullRequests,
  openDraftPullRequest,
  type Octokit,
} from "@elevate/github";
import { authorizeWrite, WriteRefused, type Status, type Usage, type WriteAction } from "@elevate/policy";

/** Where a cloud coding agent is on its pull request. */
export type AgentWork = "working" | "finished" | "failed";

/** The raw GitHub writes an executor may need. Implemented by Octokit in production and by a fake in tests. */
export interface GitHubWriter {
  createIssue(fullName: string, title: string, body: string, labels?: string[]): Promise<{ number: number; url: string }>;
  comment(fullName: string, issue: number, body: string): Promise<string>;
  assignAgent(fullName: string, issue: number, opts: { baseBranch?: string; instructions?: string; model?: string }): Promise<void>;
  openDraftPr(fullName: string, opts: { head: string; base: string; title: string; body: string }): Promise<{ url: string; number: number }>;
  linkedPrs(fullName: string, issue: number): Promise<{ url: string; number: number; draft: boolean; state: string }[]>;
  /** Read-only: whether the Copilot coding agent is still working on a PR. */
  agentWork(fullName: string, pr: number): Promise<AgentWork>;
}

export function octokitWriter(gh: Octokit): GitHubWriter {
  return {
    createIssue: (f, t, b, l) => createIssue(gh, f, t, b, l),
    comment: (f, i, b) => commentOnIssue(gh, f, i, b),
    assignAgent: (f, i, o) => assignCopilotAgent(gh, f, i, o),
    openDraftPr: (f, o) => openDraftPullRequest(gh, f, o),
    linkedPrs: (f, i) => findLinkedPullRequests(gh, f, i),
    agentWork: (f, p) => copilotWorkStatus(gh, f, p),
  };
}

/** Live state the guard needs, read fresh before every write so a reject or allow-list change stops the swarm. */
export type GuardState = { status: Status; allowSwarm: boolean };

export type GuardOptions = {
  repoFullName: string;
  defaultBranch: string;
  budget: SwarmBudget;
  state: () => Promise<GuardState>;
  audit: (action: WriteAction, target: string, details: Record<string, unknown>) => Promise<void>;
  now?: () => number;
};

export type GuardedGitHub = Omit<GitHubWriter, "openDraftPr"> & {
  openDraftPr(fullName: string, opts: { head: string; base: string; title: string; body: string; draft?: boolean }): Promise<{ url: string; number: number }>;
  /** Authorize a write that doesn't go through the GitHub API (local agent runs, `git push`). */
  authorize(action: WriteAction, fullName: string, details?: Record<string, unknown>): Promise<void>;
  /** Authorize a `git push` of `branch`: pushing the default branch is a separate, forbidden action (W1). */
  authorizePush(fullName: string, branch: string): Promise<void>;
  /** Record an agent turn (counts toward the budget). */
  turn(): void;
  usage(): Usage;
};

/**
 * TB3: the single choke point. Executors only ever receive this object, never an Octokit,
 * and every write asks the proved `authorizeWrite` first. Refusals throw `WriteRefused`
 * and are audited like allowed writes.
 */
export function guardedGitHub(raw: GitHubWriter, opts: GuardOptions): GuardedGitHub {
  const now = opts.now ?? Date.now;
  const started = now();
  const used = { tasks: 0, agentTurns: 0 };
  const usage = (): Usage => ({ ...used, minutes: Math.floor((now() - started) / 60_000) });

  async function authorize(action: WriteAction, fullName: string, details: Record<string, unknown> = {}, draft = true) {
    const s = await opts.state();
    const verdict = authorizeWrite({
      action,
      status: s.status,
      allowSwarm: s.allowSwarm,
      sameRepo: fullName.toLowerCase() === opts.repoFullName.toLowerCase(),
      draft,
      usage: usage(),
      budget: opts.budget,
    });
    await opts.audit(action, fullName, { ...details, verdict });
    if (verdict !== "allow") throw new WriteRefused(verdict, action);
    if (action === "assign_agent" || action === "run_local_agent") used.tasks++;
  }

  return {
    authorize,
    async authorizePush(fullName, branch) {
      const action: WriteAction = branch === opts.defaultBranch ? "push_default_branch" : "push_branch";
      await authorize(action, fullName, { branch });
    },
    turn() {
      used.agentTurns++;
    },
    usage,
    async createIssue(fullName, title, body, labels) {
      await authorize("create_issue", fullName, { title });
      return raw.createIssue(fullName, title, body, labels);
    },
    async comment(fullName, issue, body) {
      await authorize("comment", fullName, { issue });
      return raw.comment(fullName, issue, body);
    },
    async assignAgent(fullName, issue, o) {
      await authorize("assign_agent", fullName, { issue });
      return raw.assignAgent(fullName, issue, o);
    },
    async openDraftPr(fullName, o) {
      const draft = o.draft ?? true;
      if (o.head === opts.defaultBranch) await authorize("push_default_branch", fullName, { head: o.head });
      await authorize("open_pr", fullName, { head: o.head, base: o.base }, draft);
      return raw.openDraftPr(fullName, { head: o.head, base: o.base, title: o.title, body: o.body });
    },
    linkedPrs: (fullName, issue) => raw.linkedPrs(fullName, issue),
    agentWork: (fullName, pr) => raw.agentWork(fullName, pr),
  };
}
