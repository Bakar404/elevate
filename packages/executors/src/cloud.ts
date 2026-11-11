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

  async run(run: SwarmRun): Promise<SwarmOutcome> {
    const { github, repo } = run;
    const issue = await github.createIssue(repo.fullName, run.recommendation.title, issueBody(run), ["elevate"]);
    await run.log(`Opened ${issue.url}`);
    for (const t of run.plan.tasks) await run.setTask(t.key, "running");
    await github.assignAgent(repo.fullName, issue.number, {
      baseBranch: repo.defaultBranch,
      instructions: `Implement the plan in the issue on a new branch and open a draft pull request. ${run.plan.verification}`,
    });
    github.turn();
    await run.log("Assigned to the Copilot coding agent; waiting for its pull request");
    const prUrl = await waitForPr(run, issue.number, "Copilot");
    for (const t of run.plan.tasks) await run.setTask(t.key, prUrl ? "done" : "failed");
    if (!prUrl) throw new Error(`No pull request linked to ${issue.url} within the time budget`);
    return { prUrl, issueUrl: issue.url, summary: "Copilot coding agent opened a pull request", usage: null };
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
    return { prUrl, issueUrl: issue.url, summary: `${this.label} opened a pull request`, usage: null };
  }
}
