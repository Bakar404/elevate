import {
  and,
  audit,
  emit,
  enqueue,
  eq,
  getSetting,
  inArray,
  recommendations,
  repos,
  swarms,
  swarmTasks,
  type ExecutorKind,
  type SwarmBudget,
  type TaskStatus,
} from "@elevate/db";
import { getExecutor, guardedGitHub, type PlannedTask, type SwarmPlan } from "@elevate/executors";
import type { Status } from "@elevate/policy";
import type { Ctx } from "./context";
import { slugify } from "./ingest";
import { applyEvent } from "./lifecycle";
import { modelLabel, modelPrefs } from "./models";
import { PLAN_SYSTEM, PlanSchema } from "./prompts";

export const DEFAULT_BUDGET: SwarmBudget = { maxTasks: 6, maxMinutes: 90, maxAgentTurns: 40 };

export async function swarmBudget(ctx: Ctx): Promise<SwarmBudget> {
  return { ...DEFAULT_BUDGET, ...(await getSetting<Partial<SwarmBudget>>(ctx.db, "swarm.budget", {})) };
}

export class ApprovalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalError";
  }
}

async function load(ctx: Ctx, recommendationId: string) {
  const [row] = await ctx.db
    .select({ rec: recommendations, repo: repos })
    .from(recommendations)
    .innerJoin(repos, eq(recommendations.repoId, repos.id))
    .where(eq(recommendations.id, recommendationId));
  if (!row) throw new ApprovalError(`Recommendation ${recommendationId} not found`);
  return row;
}

async function queueSwarm(ctx: Ctx, recommendationId: string, repoId: string, tenantId: string, executor: ExecutorKind, budget?: Partial<SwarmBudget>) {
  const [swarm] = await ctx.db
    .insert(swarms)
    .values({ tenantId, recommendationId, repoId, executor, budget: { ...(await swarmBudget(ctx)), ...budget } })
    .returning();
  await enqueue(ctx.db, "swarm.run", { swarmId: swarm!.id }, { dedupeKey: `swarm.run:${swarm!.id}`, maxAttempts: 1 });
  await emit(ctx.db, { kind: "swarm.queued", swarmId: swarm!.id, message: `Swarm queued (${executor})`, data: { recommendationId } });
  return swarm!;
}

/** You approved it: record the decision and queue the swarm. The guard still checks every write. */
export async function approveRecommendation(
  ctx: Ctx,
  recommendationId: string,
  opts: { executor: ExecutorKind; budget?: Partial<SwarmBudget>; allowRepo?: boolean; actor?: string },
) {
  const { rec, repo } = await load(ctx, recommendationId);
  if (opts.allowRepo && !repo.allowSwarm) {
    await ctx.db.update(repos).set({ allowSwarm: true, updatedAt: new Date() }).where(eq(repos.id, repo.id));
    await audit(ctx.db, opts.actor ?? "user", "repo.allow_swarm", repo.fullName, { allowSwarm: true });
  } else if (!repo.allowSwarm) {
    throw new ApprovalError(`Swarms aren't allowed on ${repo.fullName} yet. Allow it first.`);
  }
  await applyEvent(ctx.db, rec.id, "approve", { decidedAt: new Date() }, opts.actor ?? "user");
  return queueSwarm(ctx, rec.id, repo.id, rec.tenantId, opts.executor, opts.budget);
}

export async function rejectRecommendation(ctx: Ctx, recommendationId: string, actor = "user") {
  const next = await applyEvent(ctx.db, recommendationId, "reject", { decidedAt: new Date() }, actor);
  await ctx.db
    .update(swarms)
    .set({ status: "cancelled", finishedAt: new Date() })
    .where(and(eq(swarms.recommendationId, recommendationId), inArray(swarms.status, ["queued", "planning"])));
  return next;
}

/** Send a recommendation back through Gate 2 (from open, gated_out or rejected). */
export async function regateRecommendation(ctx: Ctx, recommendationId: string, actor = "user") {
  const { rec } = await load(ctx, recommendationId);
  await applyEvent(ctx.db, rec.id, rec.status === "rejected" ? "reopen" : "regate", {}, actor);
  await enqueue(ctx.db, "recommendation.soundness", { recommendationId }, { dedupeKey: `recommendation.soundness:${recommendationId}` });
}

export async function retrySwarm(ctx: Ctx, recommendationId: string, executor?: ExecutorKind, actor = "user") {
  const { rec, repo } = await load(ctx, recommendationId);
  const [last] = await ctx.db.select({ executor: swarms.executor }).from(swarms).where(eq(swarms.recommendationId, rec.id)).limit(1);
  await applyEvent(ctx.db, rec.id, "retry", {}, actor);
  return queueSwarm(ctx, rec.id, repo.id, rec.tenantId, executor ?? last?.executor ?? "copilot-cloud");
}

const controllers = new Map<string, AbortController>();

export async function cancelSwarm(ctx: Ctx, swarmId: string) {
  controllers.get(swarmId)?.abort();
  await ctx.db.update(swarms).set({ status: "cancelled", finishedAt: new Date() }).where(and(eq(swarms.id, swarmId), inArray(swarms.status, ["queued", "planning"])));
}

export function planToTasks(plan: { subtasks: { key: string; title: string; instructions: string; dependsOn: string[] }[]; verification: string }): PlannedTask[] {
  const seen = new Set<string>();
  const reserved = new Set(["plan", "verify", "review", "publish"]);
  const impl: PlannedTask[] = plan.subtasks.map((s, i) => {
    // Keep only dependencies on earlier subtasks: drops invented keys and makes cycles impossible.
    const deps = s.dependsOn.filter((d) => seen.has(d));
    let key = s.key || `task-${i + 1}`;
    while (seen.has(key) || reserved.has(key)) key = `${key}-${i + 1}`;
    seen.add(key);
    return { key, role: "implementer", title: s.title, instructions: s.instructions, dependsOn: ["plan", ...deps] };
  });
  return [
    { key: "plan", role: "planner", title: "Plan the change", instructions: "Split the approved change into tasks.", dependsOn: [] },
    ...impl,
    { key: "verify", role: "tester", title: "Verify the improvement", instructions: plan.verification, dependsOn: impl.map((t) => t.key) },
    { key: "review", role: "reviewer", title: "Review the diff", instructions: "Check the diff against the plan.", dependsOn: ["verify"] },
    { key: "publish", role: "publisher", title: "Open a draft PR", instructions: "Push the swarm branch and open a draft PR.", dependsOn: ["review"] },
  ];
}

/** Run an approved recommendation's swarm: start (T2), plan, execute through the guard, and record the outcome. */
export async function runSwarm(ctx: Ctx, swarmId: string, opts: { pollMs?: number } = {}) {
  const [swarm] = await ctx.db.select().from(swarms).where(eq(swarms.id, swarmId));
  if (!swarm || swarm.status !== "queued") return;
  const { rec, repo } = await load(ctx, swarm.recommendationId);
  const log = (message: string, level: "info" | "success" | "warn" | "error" = "info") =>
    emit(ctx.db, { kind: "swarm.log", swarmId, level, message, tenantId: swarm.tenantId });

  await applyEvent(ctx.db, rec.id, "start", {}, `swarm:${swarmId}`);
  await ctx.db.update(swarms).set({ status: "planning", startedAt: new Date() }).where(eq(swarms.id, swarmId));
  const controller = new AbortController();
  controllers.set(swarmId, controller);

  try {
    const prefs = await modelPrefs(ctx);
    const planner = ctx.demo ? "demo" : await modelLabel(ctx);
    await log(`Planning "${rec.title}" for ${repo.fullName} with ${planner}`);
    const p = await ctx.llm.json({
      task: "plan",
      system: PLAN_SYSTEM,
      schema: PlanSchema,
      prompt: [
        `Repository: ${repo.fullName}`,
        `Profile:\n${repo.profileText ?? ""}`,
        `Recommendation: ${rec.title}`,
        `Change: ${rec.hypothesis.change}`,
        `Rationale: ${rec.hypothesis.rationale}`,
        `Expected impact: ${rec.hypothesis.expectedImpact}`,
        `How to measure: ${rec.gate2?.evidence.find((e) => e.label === "How to measure")?.detail ?? "n/a"}`,
        `Touchpoints: ${rec.hypothesis.touchpoints.join(", ")}`,
        `Budget: at most ${swarm.budget.maxTasks} agent tasks`,
      ].join("\n\n"),
    });
    const plan: SwarmPlan = { summary: p.summary, acceptanceCriteria: p.acceptanceCriteria, verification: p.verification, tasks: planToTasks(p) };
    await ctx.db.insert(swarmTasks).values(plan.tasks.map((t) => ({ swarmId, ...t, status: (t.role === "planner" ? "done" : "pending") as TaskStatus })));
    const branch = `elevate/${slugify(rec.title).slice(0, 40)}-${swarmId.slice(0, 6)}`;
    await ctx.db.update(swarms).set({ status: "running", branch }).where(eq(swarms.id, swarmId));
    await log(`Plan ready: ${plan.tasks.length} tasks on ${branch}`);

    const github = guardedGitHub(await ctx.writer(), {
      repoFullName: repo.fullName,
      defaultBranch: repo.defaultBranch,
      budget: swarm.budget,
      state: async () => {
        const [s] = await ctx.db
          .select({ status: recommendations.status, allowSwarm: repos.allowSwarm })
          .from(recommendations)
          .innerJoin(repos, eq(recommendations.repoId, repos.id))
          .where(eq(recommendations.id, rec.id));
        return { status: (s?.status ?? "rejected") as Status, allowSwarm: s?.allowSwarm ?? false };
      },
      audit: (action, target, details) => audit(ctx.db, `swarm:${swarmId}`, `github.${action}`, target, details, swarm.tenantId),
    });

    const outcome = await getExecutor(swarm.executor, { codingAgentModel: prefs.codingAgent }).run({
      swarmId,
      repo: { fullName: repo.fullName, defaultBranch: repo.defaultBranch },
      recommendation: { id: rec.id, title: rec.title, rationale: rec.hypothesis.rationale, expectedImpact: rec.hypothesis.expectedImpact },
      plan,
      branch,
      github,
      token: ctx.token,
      log,
      setTask: async (key, status, output) => {
        await ctx.db
          .update(swarmTasks)
          .set({
            status,
            ...(output !== undefined ? { output } : {}),
            ...(status === "running" ? { startedAt: new Date() } : {}),
            ...(status === "done" || status === "failed" ? { finishedAt: new Date() } : {}),
          })
          .where(and(eq(swarmTasks.swarmId, swarmId), eq(swarmTasks.key, key)));
        await emit(ctx.db, { kind: "swarm.task", swarmId, message: `${key}: ${status}`, data: { key, status }, tenantId: swarm.tenantId });
      },
      signal: controller.signal,
      budgetMinutes: swarm.budget.maxMinutes,
      pollMs: opts.pollMs,
    });

    if (!outcome.prUrl) throw new Error("The swarm finished without a pull request");
    await ctx.db
      .update(swarmTasks)
      .set({ status: "done", finishedAt: new Date() })
      .where(and(eq(swarmTasks.swarmId, swarmId), inArray(swarmTasks.status, ["pending", "running"])));
    await ctx.db
      .update(swarms)
      .set({
        status: "succeeded",
        prUrl: outcome.prUrl,
        issueUrl: outcome.issueUrl ?? null,
        result: { summary: outcome.summary, usage: github.usage(), models: { planner, ...outcome.models } },
        finishedAt: new Date(),
      })
      .where(eq(swarms.id, swarmId));
    await applyEvent(ctx.db, rec.id, "pr", {}, `swarm:${swarmId}`);
    await log(`Draft PR ready: ${outcome.prUrl}`, "success");
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const cancelled = controller.signal.aborted;
    await ctx.db
      .update(swarms)
      .set({ status: cancelled ? "cancelled" : "failed", error: message.slice(0, 2000), finishedAt: new Date() })
      .where(eq(swarms.id, swarmId));
    await ctx.db
      .update(swarmTasks)
      .set({ status: "skipped" })
      .where(and(eq(swarmTasks.swarmId, swarmId), eq(swarmTasks.status, "pending")));
    const [now] = await ctx.db.select({ status: recommendations.status }).from(recommendations).where(eq(recommendations.id, rec.id));
    if (now?.status === "in_progress") await applyEvent(ctx.db, rec.id, "fail", {}, `swarm:${swarmId}`);
    await log(`Swarm ${cancelled ? "cancelled" : "failed"}: ${message}`, "error");
  } finally {
    controllers.delete(swarmId);
  }
}
