import { claimJob, completeJob, emit, failJob, getSetting, recoverStaleJobs, setSetting, enqueue, type ClaimedJob } from "@elevate/db";
import { resolveGitHubToken } from "@elevate/github";
import type { Ctx } from "./context";
import { legitimacyGate, soundnessGate } from "./gates";
import { fetchSourceItems, seedSources, sweepSources, triageItems } from "./ingest";
import { matchRepo, matchTechnique } from "./matcher";
import { profileRepo, syncRepos } from "./profiler";
import { runSwarm } from "./swarm";

type Handler = (ctx: Ctx, payload: Record<string, unknown>, job: ClaimedJob) => Promise<unknown>;

const str = (p: Record<string, unknown>, k: string) => {
  const v = p[k];
  if (typeof v !== "string") throw new Error(`Job payload is missing ${k}`);
  return v;
};

export const HANDLERS: Record<string, Handler> = {
  "repos.sync": (ctx, p, job) => syncRepos(ctx, job.tenantId, { scheduled: p.scheduled === true }),
  "repo.profile": (ctx, p) => profileRepo(ctx, str(p, "repoId")),
  "repo.match": (ctx, p) => matchRepo(ctx, str(p, "repoId")),
  "sources.sweep": async (ctx, _p, job) => {
    await seedSources(ctx, job.tenantId);
    return sweepSources(ctx, job.tenantId);
  },
  "source.fetch": (ctx, p) => fetchSourceItems(ctx, str(p, "sourceId")),
  "items.triage": (ctx, _p, job) => triageItems(ctx, job.tenantId),
  "technique.legitimacy": (ctx, p) => legitimacyGate(ctx, str(p, "techniqueId")),
  "technique.match": (ctx, p) => matchTechnique(ctx, str(p, "techniqueId")),
  "recommendation.soundness": (ctx, p) => soundnessGate(ctx, str(p, "recommendationId")),
  "swarm.run": (ctx, p) => runSwarm(ctx, str(p, "swarmId")),
};

export async function runJob(ctx: Ctx, job: ClaimedJob) {
  const handler = HANDLERS[job.type];
  try {
    if (!handler) throw new Error(`No handler for job type ${job.type}`);
    await handler(ctx, job.payload, job);
    await completeJob(ctx.db, job.id);
  } catch (err) {
    const retrying = await failJob(ctx.db, job, err);
    if (!retrying) {
      await emit(ctx.db, {
        kind: "job.failed",
        level: "error",
        message: `${job.type} failed: ${(err instanceof Error ? err.message : String(err)).slice(0, 300)}`,
        data: { jobId: job.id },
        tenantId: job.tenantId,
      });
    }
  }
}

const minutes = (env: string | undefined, fallback: number) => Number(env ?? fallback) * 60_000;
const SCHEDULE = [
  { job: "sources.sweep", every: minutes(process.env.ELEVATE_SWEEP_MINUTES, 60), needsGitHub: false },
  // Cheap: one list call, plus a branch lookup only for repos that were pushed to.
  { job: "repos.sync", every: minutes(process.env.ELEVATE_SYNC_MINUTES, 5), needsGitHub: true },
];

/** Enqueue recurring jobs that are due. Cheap to call often; state lives in settings so restarts don't re-run everything. */
export async function scheduleTick(ctx: Ctx, now = Date.now()) {
  if (ctx.demo || process.env.ELEVATE_SCHEDULER === "off") return [];
  const due: string[] = [];
  for (const s of SCHEDULE) {
    const last = await getSetting<number>(ctx.db, `scheduler.${s.job}`, 0);
    if (now - last < s.every) continue;
    if (s.needsGitHub && !(await resolveGitHubToken(ctx.db).then(() => true, () => false))) continue;
    await setSetting(ctx.db, `scheduler.${s.job}`, now);
    await enqueue(ctx.db, s.job, { scheduled: true }, { dedupeKey: s.job });
    due.push(s.job);
  }
  return due;
}

export type WorkerHandle = { stop: () => Promise<void>; idle: () => Promise<void>; kick: () => void };

/**
 * A small in-process worker. Swarms can wait on cloud agents for a long time, so they run
 * alongside the queue (up to `maxSwarms`) instead of blocking it.
 */
export function startWorker(ctx: Ctx, opts: { pollMs?: number; maxSwarms?: number } = {}): WorkerHandle {
  const pollMs = opts.pollMs ?? 2000;
  const maxSwarms = opts.maxSwarms ?? 3;
  const swarmsRunning = new Set<Promise<void>>();
  let stopped = false;
  let wake: (() => void) | undefined;
  const idleWaiters: (() => void)[] = [];

  const loop = (async () => {
    await recoverStaleJobs(ctx.db);
    let lastTick = 0;
    while (!stopped) {
      if (Date.now() - lastTick > 30_000) {
        lastTick = Date.now();
        await scheduleTick(ctx).catch(() => {});
      }
      const job = swarmsRunning.size < maxSwarms ? await claimJob(ctx.db).catch(() => undefined) : undefined;
      if (!job) {
        if (!swarmsRunning.size) idleWaiters.splice(0).forEach((r) => r());
        await new Promise<void>((r) => {
          wake = r;
          setTimeout(r, pollMs);
        });
        continue;
      }
      if (job.type === "swarm.run") {
        const p: Promise<void> = runJob(ctx, job).finally(() => swarmsRunning.delete(p));
        swarmsRunning.add(p);
      } else {
        await runJob(ctx, job);
      }
    }
    await Promise.allSettled([...swarmsRunning]);
  })();

  return {
    async stop() {
      stopped = true;
      wake?.();
      await loop;
    },
    /** Check the queue now instead of at the next poll (call after enqueueing from a request). */
    kick() {
      wake?.();
    },
    /** Resolves when the queue has nothing ready and no swarm is running (tests, scripts). */
    idle() {
      return new Promise<void>((r) => {
        idleWaiters.push(r);
        wake?.();
      });
    },
  };
}

/** Drain the queue synchronously (tests and scripts). Returns the number of jobs run. */
export async function drain(ctx: Ctx, max = 500) {
  let n = 0;
  for (; n < max; n++) {
    const job = await claimJob(ctx.db);
    if (!job) break;
    await runJob(ctx, job);
  }
  return n;
}
