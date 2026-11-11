import { WriteRefused } from "@elevate/policy";
import { issueBody, type Executor, type SwarmLinks, type SwarmOutcome, type SwarmRun } from "./types";

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

const numberFromUrl = (url: string) => Number(url.split("/").pop());

/** Copilot's PR body ends with tips for Copilot users; they don't belong in a PR under your name. */
export function cleanAgentBody(body: string): string {
  const cut = body.search(/<!--\s*START COPILOT/i);
  return (cut >= 0 ? body.slice(0, cut) : body)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n-{3,}\s*$/, "")
    .trim();
}

/**
 * Republish the agent's finished PR under the token's account: one squashed commit on the
 * swarm branch, a draft PR from that branch, and the agent's PR closed with a pointer.
 * If republishing fails, the agent's PR is kept and returned.
 */
async function publishAsUser(run: SwarmRun, agentPr: string, issue: number): Promise<string> {
  const { github, repo } = run;
  const pr = numberFromUrl(agentPr);
  let mine: { url: string; number: number };
  try {
    const message = [run.recommendation.title, run.plan.summary, `Refs #${issue}`].filter(Boolean).join("\n\n");
    const { body } = await github.squashPr(repo.fullName, pr, { branch: run.branch, message });
    mine = await github.openDraftPr(repo.fullName, {
      head: run.branch,
      base: repo.defaultBranch,
      title: run.recommendation.title,
      body: [cleanAgentBody(body), `Closes #${issue}`].filter(Boolean).join("\n\n"),
    });
  } catch (err) {
    if (err instanceof WriteRefused) throw err;
    const why = err instanceof Error ? err.message : String(err);
    await run.log(`Couldn't republish ${agentPr} under your account (${why}); kept Copilot's pull request`, "warn");
    return agentPr;
  }
  await run.log(`Republished as ${mine.url} under your account, squashed into one commit on ${run.branch}`);
  try {
    await github.comment(repo.fullName, pr, `Republished as #${mine.number}. Closing this one.`);
    await github.closePr(repo.fullName, pr);
    await run.log(`Closed ${agentPr}`);
  } catch (err) {
    if (err instanceof WriteRefused) throw err;
    const why = err instanceof Error ? err.message : String(err);
    await run.log(`Opened ${mine.url} but couldn't close ${agentPr} (${why})`, "warn");
  }
  return mine.url;
}

/** Copilot coding agent: create an issue with the plan and assign it to Copilot, which opens a draft PR. */
export class CopilotCloudExecutor implements Executor {
  readonly kind = "copilot-cloud" as const;
  readonly label = "GitHub Copilot coding agent";
  /**
   * model: the coding agent's model id; omitted means GitHub's auto selection.
   * publishAsUser: republish the finished PR under the token's account and close Copilot's.
   */
  constructor(private readonly opts: { model?: string; publishAsUser?: boolean } = {}) {}

  private get codingAgent() {
    return this.opts.model || "auto (GitHub picks the model)";
  }

  async run(run: SwarmRun): Promise<SwarmOutcome> {
    const { github, repo } = run;
    const model = this.opts.model || undefined;
    const issue = await github.createIssue(repo.fullName, run.recommendation.title, issueBody(run), ["elevate"]);
    await run.log(`Opened ${issue.url}`);
    await run.onLinked?.({ issueUrl: issue.url });
    for (const t of run.plan.tasks) await run.setTask(t.key, "running");
    await github.assignAgent(repo.fullName, issue.number, {
      baseBranch: repo.defaultBranch,
      instructions: `Implement the plan in the issue on a new branch and open a draft pull request. ${run.plan.verification}`,
      ...(model ? { model } : {}),
    });
    github.turn();
    await run.log(`Assigned to the Copilot coding agent (model: ${this.codingAgent}); waiting for its pull request`);
    return this.follow(run, { issueUrl: issue.url });
  }

  async resume(run: SwarmRun, links: SwarmLinks): Promise<SwarmOutcome> {
    await run.log(`Following ${links.prUrl ?? links.issueUrl} again after a restart`);
    for (const t of run.plan.tasks) if (t.role !== "planner") await run.setTask(t.key, "running");
    return this.follow(run, links);
  }

  private async follow(run: SwarmRun, links: SwarmLinks): Promise<SwarmOutcome> {
    const issue = numberFromUrl(links.issueUrl);
    let prUrl = links.prUrl;
    if (!prUrl) {
      prUrl = await waitForPr(run, issue, "Copilot");
      if (!prUrl) {
        for (const t of run.plan.tasks) await run.setTask(t.key, "failed");
        throw new Error(`No pull request linked to ${links.issueUrl} within the time budget`);
      }
      await run.onLinked?.({ issueUrl: links.issueUrl, prUrl });
    }

    // The agent opens a "[WIP]" draft right away; the work is only done when it says so.
    for (const t of run.plan.tasks) if (t.role === "planner") await run.setTask(t.key, "done");
    await run.log(`Copilot opened ${prUrl} and is working on it`);
    const work = await waitForAgent(run, numberFromUrl(prUrl));
    for (const t of run.plan.tasks) if (t.role !== "planner") await run.setTask(t.key, work === "finished" ? "done" : "failed");
    if (work !== "finished") {
      throw new Error(
        work === "failed"
          ? `The Copilot coding agent did not finish: its session on ${prUrl} failed`
          : `The Copilot coding agent did not finish ${prUrl} within the time budget`,
      );
    }
    const finalUrl = this.opts.publishAsUser ? await publishAsUser(run, prUrl, issue) : prUrl;
    return {
      prUrl: finalUrl,
      issueUrl: links.issueUrl,
      summary: finalUrl === prUrl ? "Copilot coding agent finished a draft pull request" : `Copilot coding agent finished; republished from ${prUrl} under your account`,
      models: { codingAgent: this.codingAgent },
    };
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
    await run.onLinked?.({ issueUrl: issue.url });
    for (const t of run.plan.tasks) await run.setTask(t.key, "running");
    await github.authorize("assign_agent", repo.fullName, { issue: issue.number, via: this.mention });
    await github.comment(
      repo.fullName,
      issue.number,
      `${this.mention} please implement the plan in this issue on a new branch and open a **draft** pull request that references #${issue.number}. Do not merge.`,
    );
    github.turn();
    await run.log(`Asked ${this.mention}; waiting for its pull request`);
    return this.follow(run, { issueUrl: issue.url });
  }

  async resume(run: SwarmRun, links: SwarmLinks): Promise<SwarmOutcome> {
    await run.log(`Following ${links.prUrl ?? links.issueUrl} again after a restart`);
    for (const t of run.plan.tasks) if (t.role !== "planner") await run.setTask(t.key, "running");
    return this.follow(run, links);
  }

  private async follow(run: SwarmRun, links: SwarmLinks): Promise<SwarmOutcome> {
    const prUrl = links.prUrl ?? (await waitForPr(run, numberFromUrl(links.issueUrl), this.mention));
    for (const t of run.plan.tasks) await run.setTask(t.key, prUrl ? "done" : "failed");
    if (!prUrl) throw new Error(`No pull request linked to ${links.issueUrl} within the time budget`);
    if (!links.prUrl) await run.onLinked?.({ issueUrl: links.issueUrl, prUrl });
    return { prUrl, issueUrl: links.issueUrl, summary: `${this.label} opened a pull request` };
  }
}
