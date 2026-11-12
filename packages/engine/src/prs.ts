import { and, desc, emit, eq, getSetting, gt, isNotNull, or, recommendations, repos, sql, swarms } from "@elevate/db";
import type { MergeResult } from "@elevate/executors";
import { prVerified, type PrStatus } from "@elevate/github";
import { WriteRefused, type Status } from "@elevate/policy";
import type { Ctx } from "./context";
import { applyEvent } from "./lifecycle";
import { ApprovalError, swarmGuard } from "./swarm";

/** "Auto-merge verified PRs": off until you turn it on. ELEVATE_AUTO_MERGE=1 changes the default. */
export async function autoMerge(ctx: Ctx): Promise<boolean> {
  return getSetting<boolean>(ctx.db, "swarm.autoMerge", process.env.ELEVATE_AUTO_MERGE === "1");
}

/** How often open swarm PRs are re-checked (ELEVATE_PR_MINUTES, default 2). */
export const prCheckMinutes = () => {
  const n = Number(process.env.ELEVATE_PR_MINUTES);
  return n > 0 ? n : 2;
};

/** What elevate last saw of a swarm's PR, kept in `swarms.result.pr`. */
export type SwarmPr = PrStatus & {
  verified: boolean;
  checkedAt: string;
  /** Set when elevate merged it. */
  merge?: MergeResult & { by: "you" | "auto-merge"; at: string };
  /** GitHub refused to merge this head commit; auto-merge doesn't retry the same commit. */
  refused?: { sha: string; error: string; at: string };
};

type Tracked = {
  swarm: typeof swarms.$inferSelect;
  recStatus: Status;
  repo: { fullName: string; defaultBranch: string; allowSwarm: boolean };
};

const prNumber = (url: string) => {
  const n = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
  if (!n) throw new Error(`Not a pull request URL: ${url}`);
  return n;
};

/** Each recommendation's latest succeeded swarm owns its PR; older swarms' PRs are left alone. */
async function prSwarms(ctx: Ctx, where: Parameters<typeof and>[number]): Promise<Tracked[]> {
  const rows = await ctx.db
    .select({ swarm: swarms, recStatus: recommendations.status, repo: { fullName: repos.fullName, defaultBranch: repos.defaultBranch, allowSwarm: repos.allowSwarm } })
    .from(swarms)
    .innerJoin(recommendations, eq(swarms.recommendationId, recommendations.id))
    .innerJoin(repos, eq(swarms.repoId, repos.id))
    .where(and(eq(swarms.status, "succeeded"), isNotNull(swarms.prUrl), where))
    .orderBy(desc(swarms.createdAt));
  const seen = new Set<string>();
  return rows.filter((r) => !seen.has(r.swarm.recommendationId) && Boolean(seen.add(r.swarm.recommendationId))) as Tracked[];
}

async function owned(ctx: Ctx, swarmId: string): Promise<Tracked> {
  const [s] = await ctx.db.select({ rec: swarms.recommendationId, prUrl: swarms.prUrl }).from(swarms).where(eq(swarms.id, swarmId));
  if (!s) throw new ApprovalError(`Swarm ${swarmId} not found`);
  if (!s.prUrl) throw new ApprovalError("This swarm hasn't opened a pull request.");
  const [t] = await prSwarms(ctx, eq(swarms.recommendationId, s.rec));
  if (!t) throw new ApprovalError("This swarm didn't finish, so its pull request isn't elevate's to merge or close.");
  if (t.swarm.id !== swarmId) throw new ApprovalError("A newer swarm owns this recommendation's pull request.");
  return t;
}

/** `by: "you"` marks what you did from the page; that page already shows its own toast for it. */
const logger = (ctx: Ctx, t: Tracked, pr: number, by?: "you") => (message: string, level: "info" | "success" | "warn" | "error" = "info") =>
  emit(ctx.db, { kind: "swarm.pr", swarmId: t.swarm.id, level, message, data: by ? { pr, by } : { pr }, tenantId: t.swarm.tenantId });

async function save(ctx: Ctx, t: Tracked, pr: SwarmPr) {
  await ctx.db
    .update(swarms)
    .set({ result: sql`coalesce(${swarms.result}, '{}'::jsonb) || jsonb_build_object('pr', ${JSON.stringify(pr)}::jsonb)` })
    .where(eq(swarms.id, t.swarm.id));
  t.swarm.result = { ...(t.swarm.result ?? {}), pr };
}

const failing = (pr?: Pick<SwarmPr, "checks">) => (pr?.checks ?? []).filter((c) => c.state === "failing").map((c) => c.name);
const pending = (pr?: Pick<SwarmPr, "checks">) => (pr?.checks ?? []).filter((c) => c.state === "pending").map((c) => c.name);
const list = (names: string[]) => (names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", "));

/** Why a PR isn't verified (M3), in words. Empty when it is. */
export function prBlockers(pr: Pick<SwarmPr, "state" | "checks" | "passed" | "blocking" | "mergeable" | "mergeableState" | "baseRef">): string {
  if (pr.state === "merged") return "it's already merged";
  if (pr.state === "closed") return "it's closed";
  if (failing(pr).length) return `${list(failing(pr))} failed`;
  if (pending(pr).length) return `${list(pending(pr))} ${pending(pr).length === 1 ? "is" : "are"} still running`;
  if (pr.passed === 0) return "no checks ran on it";
  if (!pr.mergeable) {
    if (pr.mergeableState === "dirty") return `it conflicts with ${pr.baseRef}`;
    if (pr.mergeableState === "behind") return `its branch is behind ${pr.baseRef}`;
    if (pr.mergeableState === "blocked") return `a rule on ${pr.baseRef} blocks it`;
    return "GitHub hasn't confirmed it can merge yet";
  }
  return "";
}

/**
 * Read the PR fresh, follow what happened to it on GitHub (merged, closed, reopened), and with
 * auto-merge on, merge it through the guard once it's verified. Saves what it saw on the swarm.
 */
async function follow(ctx: Ctx, t: Tracked, opts: { autoMerge: boolean }): Promise<SwarmPr> {
  const number = prNumber(t.swarm.prUrl!);
  const log = logger(ctx, t, number);
  const prev = (t.swarm.result as { pr?: SwarmPr } | null)?.pr;
  const status = await (await ctx.writer()).prStatus(t.repo.fullName, number);
  const pr: SwarmPr = {
    ...status,
    verified: prVerified(status),
    checkedAt: new Date().toISOString(),
    ...(prev?.merge ? { merge: prev.merge } : {}),
    ...(prev?.refused && prev.refused.sha === status.headSha ? { refused: prev.refused } : {}),
  };
  let rec = t.recStatus;
  const apply = async (event: "merge" | "close" | "pr") => {
    rec = (await applyEvent(ctx.db, t.swarm.recommendationId, event, {}, "github")) as Status;
  };

  if (pr.state === "merged" && rec === "closed") await apply("pr");
  if (pr.state === "merged" && rec === "pr_opened") {
    await apply("merge");
    await log(`PR #${number} was merged on GitHub`, "success");
  } else if (pr.state === "closed" && rec === "pr_opened") {
    await apply("close");
    await log(`PR #${number} was closed on GitHub without merging`, "warn");
  } else if (pr.state === "open" && rec === "closed") {
    await apply("pr");
    await log(`PR #${number} was reopened on GitHub; following it again`);
  }

  if (pr.state === "open" && rec === "pr_opened") {
    const newlyFailing = failing(pr).filter((n) => !failing(prev).includes(n));
    if (pr.verified && !prev?.verified) {
      await log(`Checks passed on PR #${number}${opts.autoMerge && t.repo.allowSwarm ? "; merging it" : "; it's ready to merge"}`, "success");
    } else if (newlyFailing.length) {
      await log(`PR #${number}: ${list(newlyFailing)} failed`, "warn");
    } else if (pr.awaitingApproval > 0 && !(prev?.awaitingApproval ?? 0)) {
      await log(`PR #${number} is waiting for you to approve its workflow runs on GitHub`, "warn");
    } else if (pr.mergeableState === "dirty" && prev?.mergeableState !== "dirty") {
      await log(`PR #${number} conflicts with ${pr.baseRef}`, "warn");
    } else if (!prev) {
      await log(`Following PR #${number}: ${prBlockers(pr) || "verified"}`);
    }
  }
  await save(ctx, t, pr);

  if (opts.autoMerge && rec === "pr_opened" && pr.verified && t.repo.allowSwarm && !pr.refused) {
    return merge(ctx, { ...t, recStatus: rec }, "auto-merge").catch(async (err) => {
      await log(`Auto-merge skipped PR #${number}: ${err instanceof Error ? err.message : String(err)}`, "warn");
      return pr;
    });
  }
  return pr;
}

const githubMessage = (err: unknown) => {
  const e = err as { message?: string; response?: { data?: { message?: string } } };
  return (e.response?.data?.message ?? e.message ?? String(err)).replace(/\s+-\s+https:\/\/docs\.github\.com\S*/, "").slice(0, 300);
};

/** Merge through the guard (M1–M3 at the head commit it checks), then record it (T5). */
async function merge(ctx: Ctx, t: Tracked, by: "you" | "auto-merge"): Promise<SwarmPr> {
  const number = prNumber(t.swarm.prUrl!);
  const log = logger(ctx, t, number, by === "you" ? "you" : undefined);
  const github = await swarmGuard(ctx, t.swarm, t.repo);
  let out: Awaited<ReturnType<typeof github.mergePr>>;
  try {
    out = await github.mergePr(t.repo.fullName, number, { consent: true });
  } catch (err) {
    if (err instanceof WriteRefused) {
      // The PR changed since it was last read; re-read it so the page shows why.
      const fresh = await follow(ctx, t, { autoMerge: false });
      if (by === "auto-merge") return fresh;
      const why =
        err.verdict === "not_verified"
          ? prBlockers(fresh) || "its checks changed"
          : err.verdict === "repo_not_allowed"
            ? `swarms are off for ${t.repo.fullName}`
            : err.verdict === "not_approved"
              ? "its recommendation no longer has an open PR"
              : err.verdict.replace(/_/g, " ");
      throw new ApprovalError(`Not merging PR #${number}: ${why}.`);
    }
    const error = githubMessage(err);
    const status = await (await ctx.writer()).prStatus(t.repo.fullName, number).catch(() => undefined);
    const at = new Date().toISOString();
    const refused = status ? { ...status, verified: prVerified(status), checkedAt: at, refused: { sha: status.headSha, error, at } } : undefined;
    if (refused) await save(ctx, t, refused);
    if (by === "auto-merge") {
      await log(`Auto-merge: GitHub refused to merge PR #${number}: ${error}`, "error");
      if (refused) return refused;
    }
    throw new ApprovalError(`GitHub refused to merge PR #${number}: ${error}`);
  }
  const at = new Date().toISOString();
  const pr: SwarmPr = {
    ...out.status,
    state: "merged",
    draft: false,
    mergeable: false,
    verified: true,
    checkedAt: at,
    mergedAt: at,
    merge: { sha: out.sha, method: out.method, branchDeleted: out.branchDeleted, by, at },
  };
  await save(ctx, t, pr);
  await applyEvent(ctx.db, t.swarm.recommendationId, "merge", {}, by === "you" ? "user" : `swarm:${t.swarm.id}`);
  const branch = out.branchDeleted ? `; deleted ${out.status.headRef}` : "";
  await log(`${by === "you" ? "Merged" : "Auto-merged"} PR #${number} into ${out.status.baseRef} (${out.method})${branch}`, "success");
  return pr;
}

const CLOSED_FOR_DAYS = 7;

/**
 * Follow every swarm PR still in play: open ones, and ones closed in the last week (they can
 * be reopened on GitHub). With `swarmId`, only that swarm's PR.
 */
export async function trackPullRequests(ctx: Ctx, opts: { swarmId?: string } = {}) {
  const since = new Date(Date.now() - CLOSED_FOR_DAYS * 86_400_000);
  const tracked = opts.swarmId
    ? await owned(ctx, opts.swarmId).then((t) => [t], () => [])
    : await prSwarms(ctx, or(eq(recommendations.status, "pr_opened"), and(eq(recommendations.status, "closed"), gt(recommendations.updatedAt, since))));
  const auto = await autoMerge(ctx);
  const seen: SwarmPr[] = [];
  for (const t of tracked) {
    if (t.recStatus !== "pr_opened" && t.recStatus !== "closed") continue;
    try {
      seen.push(await follow(ctx, t, { autoMerge: auto }));
    } catch (err) {
      console.warn(`prs.track: ${t.swarm.prUrl}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return seen;
}

/** Refresh one swarm's PR now (the swarm page's Refresh button). */
export async function refreshSwarmPr(ctx: Ctx, swarmId: string) {
  return follow(ctx, await owned(ctx, swarmId), { autoMerge: await autoMerge(ctx) });
}

/** You clicked Merge: consent for this PR (M2). The guard still requires it verified (M3). */
export async function mergeSwarmPr(ctx: Ctx, swarmId: string) {
  const t = await owned(ctx, swarmId);
  if (t.recStatus !== "pr_opened") throw new ApprovalError(`Only an open PR can be merged; this one is ${t.recStatus.replace("_", " ")}.`);
  return merge(ctx, t, "you");
}

/** You clicked Close: close the PR without merging (T5) and keep the branch. */
export async function closeSwarmPr(ctx: Ctx, swarmId: string) {
  const t = await owned(ctx, swarmId);
  if (t.recStatus !== "pr_opened") throw new ApprovalError(`Only an open PR can be closed; this one is ${t.recStatus.replace("_", " ")}.`);
  const number = prNumber(t.swarm.prUrl!);
  const github = await swarmGuard(ctx, t.swarm, t.repo);
  await github.closePr(t.repo.fullName, number, { consent: true });
  await applyEvent(ctx.db, t.swarm.recommendationId, "close", {}, "user");
  await logger(ctx, t, number, "you")(`Closed PR #${number} without merging`, "warn");
  return follow(ctx, { ...t, recStatus: "closed" }, { autoMerge: false });
}

export type PrAction = "merge" | "close" | "refresh" | "reverify";
export type PrStage =
  | "superseded"
  | "merged"
  | "closed"
  | "unchecked"
  | "detached"
  | "repo_off"
  | "approval"
  | "failing"
  | "running"
  | "no_checks"
  | "unmergeable"
  | "refused"
  | "merging"
  | "ready";
export type PrNextStep = { stage: PrStage; tone: "olive" | "sky" | "sand" | "danger" | "neutral"; short: string; title: string; detail: string; actions: PrAction[] };

/** What a swarm's PR is waiting on and what you can do about it. Every stage has a next step. */
export function prNextStep(pr: SwarmPr | undefined, o: { recStatus: string; allowSwarm: boolean; autoMerge: boolean; owns?: boolean }): PrNextStep {
  const every = prCheckMinutes();
  const cadence = `elevate checks again every ${every} minute${every === 1 ? "" : "s"}`;
  if (o.owns === false) {
    return { stage: "superseded", tone: "neutral", short: "superseded", title: "Superseded", detail: "A newer swarm on this recommendation owns its pull request.", actions: [] };
  }
  if (o.recStatus === "merged" || pr?.state === "merged") {
    const m = pr?.merge;
    const detail = m
      ? `elevate ${m.by === "auto-merge" ? "auto-merged" : "merged"} it into ${pr!.baseRef} (${m.method})${m.branchDeleted ? " and deleted the branch" : ""}. Nothing left to do.`
      : `It was merged on GitHub${pr ? ` into ${pr.baseRef}` : ""}. Nothing left to do.`;
    return { stage: "merged", tone: "olive", short: "merged", title: "Merged", detail, actions: [] };
  }
  if (o.recStatus === "closed" || pr?.state === "closed") {
    return {
      stage: "closed",
      tone: "neutral",
      short: "closed",
      title: "Closed without merging",
      detail: "Reopen it on GitHub and elevate follows it again, or re-verify the recommendation to start over with a new swarm.",
      actions: o.recStatus === "closed" ? ["reverify"] : [],
    };
  }
  if (o.recStatus !== "pr_opened") {
    return {
      stage: "detached",
      tone: "neutral",
      short: "not followed",
      title: "No longer followed",
      detail: `Its recommendation is ${o.recStatus.replace(/_/g, " ")}, so elevate doesn't follow, merge or close this PR. Merge or close it on GitHub yourself.`,
      actions: [],
    };
  }
  if (!pr) {
    return { stage: "unchecked", tone: "sky", short: "checking", title: "Checking the PR", detail: `elevate hasn't read this PR's checks yet; ${cadence}. Refresh to check now.`, actions: ["refresh", "close"] };
  }
  if (!o.allowSwarm) {
    return {
      stage: "repo_off",
      tone: "sand",
      short: "swarms off",
      title: "Swarms are off for this repo",
      detail: "elevate only merges or closes PRs on repos you allow. Allow swarms on it in Repos, or merge it on GitHub yourself.",
      actions: ["refresh"],
    };
  }
  const total = pr.checks.length;
  if (pr.awaitingApproval > 0) {
    return {
      stage: "approval",
      tone: "sand",
      short: "approve runs",
      title: "Waiting for you to approve workflow runs",
      detail: "GitHub holds CI on this PR until someone approves its workflow runs. Approve them on the PR's Checks tab; elevate picks up the result.",
      actions: ["refresh", "close"],
    };
  }
  if (failing(pr).length) {
    const n = failing(pr).length;
    return {
      stage: "failing",
      tone: "danger",
      short: "checks failing",
      title: `${n} check${n === 1 ? "" : "s"} failed`,
      detail: `${list(failing(pr))} failed. Push a fix to the branch (or ask Copilot on the PR); ${cadence} and won't merge until every check passes.`,
      actions: ["refresh", "close"],
    };
  }
  if (pending(pr).length) {
    return {
      stage: "running",
      tone: "sky",
      short: "checks running",
      title: "Checks running",
      detail: `${pending(pr).length} of ${total} check${total === 1 ? "" : "s"} still running; ${cadence}${o.autoMerge ? " and merges it once they pass" : ""}.`,
      actions: ["refresh", "close"],
    };
  }
  if (pr.passed === 0) {
    return {
      stage: "no_checks",
      tone: "sand",
      short: "no checks",
      title: "No checks ran",
      detail: `Without a passing check elevate can't verify this PR, so it won't merge it.${pr.draft ? " If the repo's CI skips draft PRs, mark it ready for review on GitHub so CI runs; elevate re-checks." : ""} Or review the diff and merge it on GitHub yourself.`,
      actions: ["refresh", "close"],
    };
  }
  if (!pr.mergeable) {
    const what =
      pr.mergeableState === "dirty"
        ? { short: "conflicts", title: "Merge conflicts", detail: `The branch conflicts with ${pr.baseRef}. Resolve the conflicts on GitHub; ${cadence}.` }
        : pr.mergeableState === "behind"
          ? { short: "behind", title: `Branch is behind ${pr.baseRef}`, detail: `Update the branch on GitHub; ${cadence}.` }
          : pr.mergeableState === "blocked"
            ? { short: "blocked", title: "Blocked by a branch rule", detail: `A rule on ${pr.baseRef} (like a required review) blocks the merge. Complete it on GitHub; ${cadence}.` }
            : { short: "checking", title: "GitHub is still checking", detail: `GitHub hasn't worked out whether this PR can merge yet; ${cadence}.` };
    return { stage: "unmergeable", tone: "sand", ...what, actions: ["refresh", "close"] };
  }
  const neutral = pr.checks.filter((c) => c.state === "neutral").length;
  const passed = `${pr.passed} check${pr.passed === 1 ? "" : "s"} passed${neutral ? ` (${neutral} skipped)` : ""}, none failing`;
  if (pr.refused) {
    return {
      stage: "refused",
      tone: "danger",
      short: "merge refused",
      title: "GitHub refused the merge",
      detail: `${pr.refused.error}. Fix it on GitHub and merge again, or push a commit and elevate re-checks.`,
      actions: ["merge", "refresh", "close"],
    };
  }
  if (o.autoMerge) {
    return {
      stage: "merging",
      tone: "olive",
      short: "merging",
      title: "Verified: auto-merging",
      detail: `${passed}. Auto-merge is on, so elevate squash-merges it on its next check (within ${every} minute${every === 1 ? "" : "s"}), or merge it now.`,
      actions: ["merge", "refresh", "close"],
    };
  }
  return {
    stage: "ready",
    tone: "olive",
    short: "ready to merge",
    title: "Verified: ready to merge",
    detail: `${passed}, and GitHub can merge it. Merge it now (squash${pr.draft ? "; elevate marks the draft ready first" : ""}), or turn on auto-merge in Settings so elevate merges verified PRs itself.`,
    actions: ["merge", "close", "refresh"],
  };
}
