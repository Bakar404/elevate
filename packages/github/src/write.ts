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
