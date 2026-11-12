import type { SwarmBudget } from "@elevate/db";
import {
  assignCopilotAgent,
  closePullRequest,
  commentOnIssue,
  copilotWorkStatus,
  createIssue,
  findLinkedPullRequests,
  mergePullRequest,
  openDraftPullRequest,
  pullRequestStatus,
  squashPullRequest,
  type Octokit,
  type PrStatus,
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
  /** Squash a PR into one commit, authored by the token's user, on a new branch. Returns the PR's body. */
  squashPr(fullName: string, pr: number, opts: { branch: string; message: string }): Promise<{ sha: string; body: string }>;
  closePr(fullName: string, pr: number): Promise<void>;
  /** Read-only: the PR's state, whether GitHub can merge it, and the checks on its head commit. */
  prStatus(fullName: string, pr: number): Promise<PrStatus>;
  /** Mark a draft ready, merge exactly at `sha`, then delete `deleteBranch`. */
  mergePr(fullName: string, pr: number, opts: { sha: string; deleteBranch?: string }): Promise<MergeResult>;
}

export type MergeResult = { sha: string; method: string; branchDeleted: boolean };

export function octokitWriter(gh: Octokit): GitHubWriter {
  return {
    createIssue: (f, t, b, l) => createIssue(gh, f, t, b, l),
    comment: (f, i, b) => commentOnIssue(gh, f, i, b),
    assignAgent: (f, i, o) => assignCopilotAgent(gh, f, i, o),
    openDraftPr: (f, o) => openDraftPullRequest(gh, f, o),
    linkedPrs: (f, i) => findLinkedPullRequests(gh, f, i),
    agentWork: (f, p) => copilotWorkStatus(gh, f, p),
    squashPr: (f, p, o) => squashPullRequest(gh, f, p, o),
    closePr: (f, p) => closePullRequest(gh, f, p),
    prStatus: (f, p) => pullRequestStatus(gh, f, p),
    mergePr: (f, p, o) => mergePullRequest(gh, f, p, o),
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

export type GuardedGitHub = Omit<GitHubWriter, "openDraftPr" | "closePr" | "mergePr"> & {
  openDraftPr(fullName: string, opts: { head: string; base: string; title: string; body: string; draft?: boolean }): Promise<{ url: string; number: number }>;
  /** Mid-run (the agent's own PR) or, with your consent, the swarm's open PR (M2). */
  closePr(fullName: string, pr: number, opts?: { consent?: boolean }): Promise<void>;
  /**
   * M1–M3: merge the swarm's open PR, with your consent, only when a check passed, none is
   * failing or pending, and GitHub can merge it. Reads the PR fresh and merges at the head
   * commit it checked, so a push after the check makes GitHub refuse the merge.
   */
  mergePr(fullName: string, pr: number, opts: { consent: boolean }): Promise<MergeResult & { status: PrStatus }>;
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

  type Facts = { draft?: boolean; consent?: boolean; checksPassed?: number; checksBlocking?: number; mergeable?: boolean };

  async function authorize(action: WriteAction, fullName: string, details: Record<string, unknown> = {}, facts: Facts = {}) {
    const s = await opts.state();
    const verdict = authorizeWrite({
      action,
      status: s.status,
      allowSwarm: s.allowSwarm,
      sameRepo: fullName.toLowerCase() === opts.repoFullName.toLowerCase(),
      draft: facts.draft ?? true,
      consent: facts.consent ?? false,
      checksPassed: facts.checksPassed ?? 0,
      checksBlocking: facts.checksBlocking ?? 0,
      mergeable: facts.mergeable ?? false,
      usage: usage(),
      budget: opts.budget,
    });
    await opts.audit(action, fullName, { ...details, verdict });
    if (verdict !== "allow") throw new WriteRefused(verdict, action);
    if (action === "assign_agent" || action === "run_local_agent") used.tasks++;
  }

  return {
    authorize: (action, fullName, details) => authorize(action, fullName, details),
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
      await authorize("open_pr", fullName, { head: o.head, base: o.base }, { draft });
      return raw.openDraftPr(fullName, { head: o.head, base: o.base, title: o.title, body: o.body });
    },
    linkedPrs: (fullName, issue) => raw.linkedPrs(fullName, issue),
    agentWork: (fullName, pr) => raw.agentWork(fullName, pr),
    async squashPr(fullName, pr, o) {
      const action: WriteAction = o.branch === opts.defaultBranch ? "push_default_branch" : "push_branch";
      await authorize(action, fullName, { branch: o.branch, squash: pr });
      return raw.squashPr(fullName, pr, o);
    },
    async closePr(fullName, pr, o) {
      await authorize("close_pr", fullName, { pr }, { consent: o?.consent ?? false });
      return raw.closePr(fullName, pr);
    },
    prStatus: (fullName, pr) => raw.prStatus(fullName, pr),
    async mergePr(fullName, pr, o) {
      const status = await raw.prStatus(fullName, pr);
      const facts = { consent: o.consent, checksPassed: status.passed, checksBlocking: status.blocking, mergeable: status.mergeable };
      await authorize("merge_pr", fullName, { pr, sha: status.headSha, passed: status.passed, blocking: status.blocking, mergeable: status.mergeable }, facts);
      const deleteBranch = status.sameRepoHead && status.headRef !== opts.defaultBranch ? status.headRef : undefined;
      const merged = await raw.mergePr(fullName, pr, { sha: status.headSha, deleteBranch });
      return { ...merged, status };
    },
  };
}
