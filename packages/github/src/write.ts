import type { Octokit } from "@octokit/rest";

function split(fullName: string) {
  const [owner, repo] = fullName.split("/") as [string, string];
  return { owner, repo };
}

export async function createIssue(gh: Octokit, fullName: string, title: string, body: string, labels: string[] = []) {
  const res = await gh.issues.create({ ...split(fullName), title, body, labels });
  return { number: res.data.number, url: res.data.html_url, nodeId: res.data.node_id };
}

export async function commentOnIssue(gh: Octokit, fullName: string, issue: number, body: string) {
  const res = await gh.issues.createComment({ ...split(fullName), issue_number: issue, body });
  return res.data.html_url;
}

/**
 * Assign an issue to the Copilot coding agent. Uses the REST assignee endpoint with the
 * agent bot login, falling back to GraphQL suggestedActors for older API behaviour.
 */
export async function assignCopilotAgent(
  gh: Octokit,
  fullName: string,
  issue: number,
  opts: { baseBranch?: string; instructions?: string; model?: string } = {},
) {
  try {
    await gh.request("POST /repos/{owner}/{repo}/issues/{issue_number}/assignees", {
      ...split(fullName),
      issue_number: issue,
      assignees: ["copilot-swe-agent[bot]"],
      agent_assignment: {
        target_repo: fullName,
        base_branch: opts.baseBranch,
        custom_instructions: opts.instructions ?? "",
        ...(opts.model ? { model: opts.model } : {}),
      },
    } as never);
    const check = await gh.issues.get({ ...split(fullName), issue_number: issue });
    if (check.data.assignees?.some((a) => /copilot/i.test(a.login))) return;
  } catch {
    // try GraphQL below
  }
  const { owner, repo } = split(fullName);
  const q = await gh.graphql<{
    repository: {
      id: string;
      issue: { id: string };
      suggestedActors: { nodes: { login: string; id: string }[] };
    };
  }>(
    `query($owner:String!,$repo:String!,$n:Int!){ repository(owner:$owner,name:$repo){ id issue(number:$n){ id }
       suggestedActors(capabilities:[CAN_BE_ASSIGNED], first:100){ nodes { login ... on Bot { id } ... on User { id } } } } }`,
    { owner, repo, n: issue },
  );
  const bot = q.repository.suggestedActors.nodes.find((n) => n.login === "copilot-swe-agent");
  if (!bot) throw new Error(`Copilot coding agent is not enabled for ${fullName}`);
  await gh.graphql(
    `mutation($a:ID!,$ids:[ID!]!){ replaceActorsForAssignable(input:{assignableId:$a, actorIds:$ids}){ clientMutationId } }`,
    { a: q.repository.issue.id, ids: [bot.id] },
  );
}

/**
 * Whether the Copilot coding agent is still working on a PR. It opens a "[WIP]" draft within
 * seconds, then posts copilot_work_started / copilot_work_finished(_failure) timeline events.
 */
export async function copilotWorkStatus(gh: Octokit, fullName: string, pr: number): Promise<"working" | "finished" | "failed"> {
  const events = await gh.paginate(gh.issues.listEventsForTimeline, { ...split(fullName), issue_number: pr, per_page: 100 });
  return copilotWorkFromEvents(events.map((e) => (e as { event?: string }).event ?? ""));
}

/** The latest copilot_work_* event decides; no event yet means the agent hasn't finished. */
export function copilotWorkFromEvents(events: string[]): "working" | "finished" | "failed" {
  const last = events.filter((e) => e.startsWith("copilot_work_")).at(-1);
  if (!last || last === "copilot_work_started") return "working";
  return /fail|error|cancel|timed_out/.test(last) ? "failed" : "finished";
}

/** Find PRs that reference an issue (Copilot agent / Actions-based agents link back). */
export async function findLinkedPullRequests(gh: Octokit, fullName: string, issue: number) {
  const res = await gh.issues.listEventsForTimeline({ ...split(fullName), issue_number: issue, per_page: 100 });
  const prs: { url: string; number: number; draft: boolean; state: string }[] = [];
  for (const e of res.data as { event?: string; source?: { issue?: { pull_request?: unknown; html_url: string; number: number; draft?: boolean; state: string } } }[]) {
    const src = e.source?.issue;
    if (e.event === "cross-referenced" && src?.pull_request) {
      prs.push({ url: src.html_url, number: src.number, draft: Boolean(src.draft), state: src.state });
    }
  }
  return prs;
}

export async function openDraftPullRequest(
  gh: Octokit,
  fullName: string,
  opts: { head: string; base: string; title: string; body: string },
) {
  const res = await gh.pulls.create({ ...split(fullName), ...opts, draft: true });
  return { url: res.data.html_url, number: res.data.number };
}

/**
 * Squash a pull request's changes into one commit on a new branch. The commit has the PR's
 * final tree and the merge base as its only parent, so its diff is exactly the PR's diff.
 * Author and committer default to the token's user, which is how the PR becomes yours.
 */
export async function squashPullRequest(gh: Octokit, fullName: string, pr: number, opts: { branch: string; message: string }) {
  const r = split(fullName);
  const { data: p } = await gh.pulls.get({ ...r, pull_number: pr });
  const { data: cmp } = await gh.repos.compareCommitsWithBasehead({ ...r, basehead: `${p.base.sha}...${p.head.sha}` });
  const { data: head } = await gh.git.getCommit({ ...r, commit_sha: p.head.sha });
  const { data: commit } = await gh.git.createCommit({ ...r, message: opts.message, tree: head.tree.sha, parents: [cmp.merge_base_commit.sha] });
  await gh.git.createRef({ ...r, ref: `refs/heads/${opts.branch}`, sha: commit.sha });
  return { sha: commit.sha, body: p.body ?? "" };
}

export async function closePullRequest(gh: Octokit, fullName: string, pr: number) {
  await gh.pulls.update({ ...split(fullName), pull_number: pr, state: "closed" });
}

/** One check on a PR's head commit: passed, neutral (skipped), failing (failed, cancelled, timed out) or pending. */
export type CheckState = "passed" | "neutral" | "failing" | "pending";
export type PrCheck = { name: string; state: CheckState; url: string | null };

export type PrStatus = {
  number: number;
  url: string;
  title: string;
  state: "open" | "closed" | "merged";
  draft: boolean;
  /** Open, GitHub computed it mergeable, and no conflicts, required reviews or out-of-date base block it. */
  mergeable: boolean;
  /** GitHub's own word: clean, unstable, dirty (conflicts), blocked, behind, draft, unknown (still computing). */
  mergeableState: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  /** The head branch lives in this repo (not a fork), so elevate may delete it after merging. */
  sameRepoHead: boolean;
  checks: PrCheck[];
  passed: number;
  /** Checks that failed, were cancelled, timed out, or haven't finished. */
  blocking: number;
  /** Workflow runs on the head commit waiting for someone to approve them on GitHub. */
  awaitingApproval: number;
  mergedAt: string | null;
  closedAt: string | null;
};

/** M3's "verified": a check passed, none failing or pending, and GitHub can merge it. */
export const prVerified = (s: Pick<PrStatus, "state" | "passed" | "blocking" | "mergeable">) =>
  s.state === "open" && s.passed > 0 && s.blocking === 0 && s.mergeable;

export function checkRunState(status: string | null | undefined, conclusion: string | null | undefined): CheckState {
  if (status !== "completed") return "pending";
  if (conclusion === "success") return "passed";
  if (conclusion === "neutral" || conclusion === "skipped") return "neutral";
  return "failing";
}

export function commitStatusState(state: string): CheckState {
  return state === "success" ? "passed" : state === "pending" ? "pending" : "failing";
}

/** Latest run per check name wins: a re-run or a later workflow replaces the earlier result. */
export function summarizeChecks(runs: { id: number; name: string; status: string | null; conclusion: string | null; html_url: string | null }[], statuses: { context: string; state: string; target_url: string | null }[]) {
  const latest = new Map<string, (typeof runs)[number]>();
  for (const r of runs) if ((latest.get(r.name)?.id ?? -1) < r.id) latest.set(r.name, r);
  const checks: PrCheck[] = [
    ...[...latest.values()].map((r) => ({ name: r.name, state: checkRunState(r.status, r.conclusion), url: r.html_url })),
    ...statuses.map((s) => ({ name: s.context, state: commitStatusState(s.state), url: s.target_url })),
  ].sort((a, b) => a.name.localeCompare(b.name));
  return {
    checks,
    passed: checks.filter((c) => c.state === "passed").length,
    blocking: checks.filter((c) => c.state === "failing" || c.state === "pending").length,
  };
}

const UNMERGEABLE = new Set(["dirty", "blocked", "behind"]);

/** Read-only: a PR's state, whether it can merge, and every check on its head commit. */
export async function pullRequestStatus(gh: Octokit, fullName: string, pr: number): Promise<PrStatus> {
  const r = split(fullName);
  const { data: p } = await gh.pulls.get({ ...r, pull_number: pr });
  const ref = p.head.sha;
  const [runs, combined, waiting] = await Promise.all([
    gh.paginate(gh.checks.listForRef, { ...r, ref, per_page: 100 }),
    gh.repos.getCombinedStatusForRef({ ...r, ref, per_page: 100 }).then((x) => x.data.statuses),
    gh.actions
      .listWorkflowRunsForRepo({ ...r, head_sha: ref, status: "action_required", per_page: 20 })
      .then((x) => x.data.total_count)
      .catch(() => 0),
  ]);
  const state = p.merged ? "merged" : p.state === "open" ? "open" : "closed";
  return {
    number: p.number,
    url: p.html_url,
    title: p.title,
    state,
    draft: Boolean(p.draft),
    mergeable: state === "open" && p.mergeable === true && !UNMERGEABLE.has(p.mergeable_state),
    mergeableState: p.mergeable_state ?? "unknown",
    headSha: ref,
    headRef: p.head.ref,
    baseRef: p.base.ref,
    sameRepoHead: p.head.repo?.full_name?.toLowerCase() === fullName.toLowerCase(),
    ...summarizeChecks(runs, combined),
    awaitingApproval: waiting,
    mergedAt: p.merged_at,
    closedAt: p.closed_at,
  };
}

/**
 * Merge a PR exactly at `sha` (GitHub refuses if the head moved since it was checked). Marks a
 * draft ready for review first, squashes when the repo allows it, then deletes the head branch.
 */
export async function mergePullRequest(gh: Octokit, fullName: string, pr: number, opts: { sha: string; deleteBranch?: string }) {
  const r = split(fullName);
  const [{ data: p }, { data: repo }] = await Promise.all([gh.pulls.get({ ...r, pull_number: pr }), gh.repos.get(r)]);
  if (p.draft) {
    await gh.graphql(`mutation($id:ID!){ markPullRequestReadyForReview(input:{pullRequestId:$id}){ pullRequest { isDraft } } }`, { id: p.node_id });
  }
  const method = repo.allow_squash_merge !== false ? "squash" : repo.allow_merge_commit !== false ? "merge" : "rebase";
  const attempt = () =>
    gh.pulls.merge({
      ...r,
      pull_number: pr,
      sha: opts.sha,
      merge_method: method,
      ...(method === "squash" ? { commit_title: `${p.title} (#${pr})` } : {}),
    });
  let res: Awaited<ReturnType<typeof attempt>> | undefined;
  // Right after leaving draft, GitHub can briefly still answer 405 while it recomputes mergeability.
  for (let i = 0; !res; i++) {
    try {
      res = await attempt();
    } catch (err) {
      if (!p.draft || i >= 3 || (err as { status?: number }).status !== 405) throw err;
      await new Promise((ok) => setTimeout(ok, 1500));
    }
  }
  const merged = res.data;
  let branchDeleted = false;
  if (opts.deleteBranch && opts.deleteBranch !== repo.default_branch) {
    branchDeleted = await gh.git
      .deleteRef({ ...r, ref: `heads/${opts.deleteBranch}` })
      .then(() => true)
      .catch(() => false);
  }
  return { sha: merged.sha, method, branchDeleted };
}
