import type { PrStatus } from "@elevate/github";
import type { AgentWork, GitHubWriter } from "./guard";
import { topoOrder, issueBody, type Executor, type SwarmOutcome, type SwarmRun } from "./types";

export type FakeWrite = { op: keyof GitHubWriter; fullName: string; detail: Record<string, unknown> };

/** In-memory GitHub for tests and the offline demo. Records every write that reaches it. */
export class FakeGitHub implements GitHubWriter {
  readonly writes: FakeWrite[] = [];
  private n = 0;
  private prs = new Map<number, { url: string; number: number; draft: boolean; state: string }[]>();
  private opened = new Map<number, { head: string; base: string; title: string }>();
  /** Scripted PR status by number. Anything unset reads as an open draft whose one check passed. */
  readonly prStates = new Map<number, Partial<PrStatus>>();

  async createIssue(fullName: string, title: string) {
    const number = ++this.n;
    this.writes.push({ op: "createIssue", fullName, detail: { title, number } });
    return { number, url: `https://github.com/${fullName}/issues/${number}` };
  }
  async comment(fullName: string, issue: number, body: string) {
    this.writes.push({ op: "comment", fullName, detail: { issue, body } });
    return `https://github.com/${fullName}/issues/${issue}#comment-${++this.n}`;
  }
  async assignAgent(fullName: string, issue: number, o: { model?: string } = {}) {
    this.writes.push({ op: "assignAgent", fullName, detail: { issue, ...(o.model ? { model: o.model } : {}) } });
    // The "agent" answers with a linked draft PR.
    const number = ++this.n;
    this.prs.set(issue, [{ url: `https://github.com/${fullName}/pull/${number}`, number, draft: true, state: "open" }]);
  }
  /** Scripted answers for agentWork, consumed one per poll; empty means the agent is done. */
  agentStates: AgentWork[] = [];
  async agentWork(_fullName: string, _pr: number): Promise<AgentWork> {
    return this.agentStates.shift() ?? "finished";
  }
  async openDraftPr(fullName: string, o: { head: string; base: string; title: string }) {
    const number = ++this.n;
    this.writes.push({ op: "openDraftPr", fullName, detail: { ...o, number } });
    this.opened.set(number, { head: o.head, base: o.base, title: o.title });
    return { url: `https://github.com/${fullName}/pull/${number}`, number };
  }
  async linkedPrs(_fullName: string, issue: number) {
    return this.prs.get(issue) ?? [];
  }
  /** Make squashPr fail, as if the branch already existed. */
  failSquash = false;
  async squashPr(fullName: string, pr: number, o: { branch: string; message: string }) {
    if (this.failSquash) throw new Error(`Reference refs/heads/${o.branch} already exists`);
    this.writes.push({ op: "squashPr", fullName, detail: { pr, ...o } });
    return {
      sha: `sha${++this.n}`,
      body: "Adds the change.\n\n<!-- START COPILOT CODING AGENT TIPS -->\n---\nTips for Copilot",
    };
  }
  async closePr(fullName: string, pr: number) {
    this.writes.push({ op: "closePr", fullName, detail: { pr } });
    this.prStates.set(pr, { ...this.prStates.get(pr), state: "closed", closedAt: new Date().toISOString() });
  }
  async prStatus(fullName: string, pr: number): Promise<PrStatus> {
    const s = this.prStates.get(pr) ?? {};
    const o = this.opened.get(pr);
    const state = s.state ?? "open";
    const checks = s.checks ?? [{ name: "ci", state: "passed" as const, url: null }];
    return {
      number: pr,
      url: `https://github.com/${fullName}/pull/${pr}`,
      title: o?.title ?? `Pull request ${pr}`,
      state,
      draft: state === "open",
      mergeable: state === "open",
      mergeableState: state === "open" ? "draft" : "unknown",
      headSha: `head${pr}`,
      headRef: o?.head ?? `agent/pr-${pr}`,
      baseRef: o?.base ?? "main",
      sameRepoHead: true,
      checks,
      passed: checks.filter((c) => c.state === "passed").length,
      blocking: checks.filter((c) => c.state === "failing" || c.state === "pending").length,
      awaitingApproval: 0,
      mergedAt: null,
      closedAt: null,
      ...s,
    };
  }
  async mergePr(fullName: string, pr: number, o: { sha: string; deleteBranch?: string }) {
    this.writes.push({ op: "mergePr", fullName, detail: { pr, ...o } });
    this.prStates.set(pr, { ...this.prStates.get(pr), state: "merged", draft: false, mergeable: false, mergedAt: new Date().toISOString() });
    return { sha: `merge${++this.n}`, method: "squash", branchDeleted: Boolean(o.deleteBranch) };
  }
}

/** Walks the task DAG without calling any model, then publishes through the guard like a real executor. */
export class FakeExecutor implements Executor {
  readonly kind = "fake" as const;
  readonly label = "Simulated swarm (no agents)";

  async run(run: SwarmRun): Promise<SwarmOutcome> {
    const { github, repo } = run;
    const issue = await github.createIssue(repo.fullName, run.recommendation.title, issueBody(run), ["elevate"]);
    await run.log(`Opened tracking issue ${issue.url}`);
    for (const t of topoOrder(run.plan.tasks)) {
      if (run.signal?.aborted) throw new Error("Swarm cancelled");
      await run.setTask(t.key, "running");
      if (t.role === "implementer" || t.role === "tester") {
        await github.authorize("run_local_agent", repo.fullName, { task: t.key });
        github.turn();
      }
      await run.setTask(t.key, "done", `Simulated: ${t.title}`);
    }
    await github.authorizePush(repo.fullName, run.branch);
    const pr = await github.openDraftPr(repo.fullName, {
      head: run.branch,
      base: repo.defaultBranch,
      title: run.recommendation.title,
      body: `${run.plan.summary}\n\nCloses #${issue.number}`,
    });
    await run.log(`Opened draft PR ${pr.url}`, "success");
    return { prUrl: pr.url, issueUrl: issue.url, summary: "Simulated swarm finished" };
  }
}
