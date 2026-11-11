import { issueBody, type Executor, type SwarmOutcome, type SwarmRun } from "./types";

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("Swarm cancelled"));
    });
  });

/** Wait for the cloud agent to link a pull request to the tracking issue, within the swarm's time budget. */
async function waitForPr(run: SwarmRun, issue: number, label: string): Promise<string | undefined> {
  const pollMs = run.pollMs ?? 30_000;
  for (;;) {
    const prs = await run.github.linkedPrs(run.repo.fullName, issue);
    const pr = prs.find((p) => p.state === "open") ?? prs[0];
    if (pr) {
      if (!pr.draft) await run.log(`${label} opened ${pr.url} as ready for review; elevate never merges it`, "warn");
      return pr.url;
    }
    // The guard refuses new agent work past the budget; here we just stop waiting at the same limit.
    const { minutes } = run.github.usage();
    if (minutes >= run.budgetMinutes) return undefined;
    await sleep(pollMs, run.signal);
  }
}

/** Copilot coding agent: create an issue with the plan and assign it to Copilot, which opens a draft PR. */
export class CopilotCloudExecutor implements Executor {
  readonly kind = "copilot-cloud" as const;
  readonly label = "GitHub Copilot coding agent";
  /** model: the coding agent's model id; omitted means GitHub's auto selection. */
  constructor(private readonly opts: { model?: string } = {}) {}

  async run(run: SwarmRun): Promise<SwarmOutcome> {
    const { github, repo } = run;
    const model = this.opts.model || undefined;
    const codingAgent = model ?? "auto (GitHub picks the model)";
    const issue = await github.createIssue(repo.fullName, run.recommendation.title, issueBody(run), ["elevate"]);
    await run.log(`Opened ${issue.url}`);
    for (const t of run.plan.tasks) await run.setTask(t.key, "running");
    await github.assignAgent(repo.fullName, issue.number, {
      baseBranch: repo.defaultBranch,
      instructions: `Implement the plan in the issue on a new branch and open a draft pull request. ${run.plan.verification}`,
      ...(model ? { model } : {}),
    });
    github.turn();
    await run.log(`Assigned to the Copilot coding agent (model: ${codingAgent}); waiting for its pull request`);
    const prUrl = await waitForPr(run, issue.number, "Copilot");
    if (!prUrl) {
      for (const t of run.plan.tasks) await run.setTask(t.key, "failed");
      throw new Error(`No pull request linked to ${issue.url} within the time budget`);
    }

    // The agent opens a "[WIP]" draft right away; the work is only done when it says so.
    for (const t of run.plan.tasks) if (t.role === "planner") await run.setTask(t.key, "done");
    await run.log(`Copilot opened ${prUrl} and is working on it`);
    const work = await waitForAgent(run, Number(prUrl.split("/").pop()));
    for (const t of run.plan.tasks) if (t.role !== "planner") await run.setTask(t.key, work === "finished" ? "done" : "failed");
    if (work !== "finished") {
      throw new Error(
        work === "failed"
          ? `The Copilot coding agent did not finish: its session on ${prUrl} failed`
          : `The Copilot coding agent did not finish ${prUrl} within the time budget`,
      );
    }
    return { prUrl, issueUrl: issue.url, summary: "Copilot coding agent finished a draft pull request", models: { codingAgent } };
  }
}

/** Poll until the coding agent finishes or fails, within the swarm's time budget. */
async function waitForAgent(run: SwarmRun, pr: number): Promise<"finished" | "failed" | "timeout"> {
  const pollMs = run.pollMs ?? 30_000;
  for (;;) {
    const s = await run.github.agentWork(run.repo.fullName, pr);
    if (s !== "working") return s;
    if (run.github.usage().minutes >= run.budgetMinutes) return "timeout";
    await sleep(pollMs, run.signal);
  }
}

/**
 * Agents driven by a GitHub Action that reacts to a mention (anthropics/claude-code-action, Codex cloud).
 * The repo must have the action installed; we create the issue and mention the agent.
 */
export class MentionExecutor implements Executor {
  constructor(
    readonly kind: "claude-action" | "codex-cloud",
    readonly label: string,
    private readonly mention: string,
  ) {}

  async run(run: SwarmRun): Promise<SwarmOutcome> {
    const { github, repo } = run;
    const issue = await github.createIssue(repo.fullName, run.recommendation.title, issueBody(run), ["elevate"]);
    await run.log(`Opened ${issue.url}`);
    for (const t of run.plan.tasks) await run.setTask(t.key, "running");
    await github.authorize("assign_agent", repo.fullName, { issue: issue.number, via: this.mention });
    await github.comment(
      repo.fullName,
      issue.number,
      `${this.mention} please implement the plan in this issue on a new branch and open a **draft** pull request that references #${issue.number}. Do not merge.`,
    );
    github.turn();
    await run.log(`Asked ${this.mention}; waiting for its pull request`);
    const prUrl = await waitForPr(run, issue.number, this.mention);
    for (const t of run.plan.tasks) await run.setTask(t.key, prUrl ? "done" : "failed");
    if (!prUrl) throw new Error(`No pull request linked to ${issue.url} within the time budget`);
    return { prUrl, issueUrl: issue.url, summary: `${this.label} opened a pull request` };
  }
}
