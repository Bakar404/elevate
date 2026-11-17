import { claimJob, completeJob, emit, failJob, getSetting, recoverStaleJobs, setSetting, enqueue, type ClaimedJob } from "@elevate/db";
import { resolveGitHubToken } from "@elevate/github";
import type { Ctx } from "./context";
import { reviewDue } from "./access";
import { classifyTechniques } from "./frontier";
import { legitimacyGate, soundnessGate } from "./gates";
import { fetchSourceItems, retryFailedTriage, seedSources, sweepSources, triageItems } from "./ingest";
import { matchRepo, matchTechnique } from "./matcher";
import { profileRepo, syncRepos } from "./profiler";
import { prCheckMinutes, trackPullRequests } from "./prs";
import { resumeSwarms, runSwarm } from "./swarm";

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
  "sources.sweep": async (ctx, p, job) => {
    await seedSources(ctx, job.tenantId);
    // Sweep now retries every failed item before it queues this job; a scheduled sweep retries those with tries left.
    if (p.scheduled === true) await retryFailedTriage(ctx, job.tenantId);
    // Sort any technique that triage didn't (ones recorded before it said whether they're cutting-edge). Free once all are sorted.
    await enqueue(ctx.db, "techniques.classify", {}, { dedupeKey: `techniques.classify:${job.tenantId}`, tenantId: job.tenantId });
    const fetching = await sweepSources(ctx, job.tenantId);
    // Pick up reviews that are due: lost ones, and recent verdicts from an older gate calibration (a few per sweep).
    await reviewDue(ctx, job.tenantId);
    return fetching;
  },
  "source.fetch": (ctx, p) => fetchSourceItems(ctx, str(p, "sourceId")),
  "items.triage": (ctx, _p, job) => triageItems(ctx, job.tenantId, undefined, job.dedupeKey),
  "techniques.classify": (ctx, _p, job) => classifyTechniques(ctx, job.tenantId, job.dedupeKey),
  "technique.legitimacy": (ctx, p) => legitimacyGate(ctx, str(p, "techniqueId")),
  "technique.match": (ctx, p) => matchTechnique(ctx, str(p, "techniqueId")),
  "recommendation.soundness": (ctx, p) => soundnessGate(ctx, str(p, "recommendationId")),
  "swarm.run": (ctx, p) => runSwarm(ctx, str(p, "swarmId"), { resume: p.resume === true }),
  "prs.track": (ctx, p) => trackPullRequests(ctx, { swarmId: typeof p.swarmId === "string" ? p.swarmId : undefined }),
};

/** How long a job may run before the queue gives up on it and retries it later (ELEVATE_JOB_TIMEOUT_MINUTES, default 30). */
export function jobTimeoutMs() {
  const n = Number(process.env.ELEVATE_JOB_TIMEOUT_MINUTES);
  return (Number.isFinite(n) && n > 0 ? n : 30) * 60_000;
}

class JobTimeout extends Error {}

const span = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} seconds`);

/**
 * Runs one job and records how it went. Jobs run one at a time, so a call that never answers would
 * hold up every job behind it: past `timeoutMs` the job is failed (and retried) and the queue moves
 * on. Swarms are exempt; they run alongside the queue under their own budget.
 */
export async function runJob(ctx: Ctx, job: ClaimedJob, timeoutMs = job.type === "swarm.run" ? 0 : jobTimeoutMs()) {
  const handler = HANDLERS[job.type];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (!handler) throw new Error(`No handler for job type ${job.type}`);
    const work = handler(ctx, job.payload, job);
    if (timeoutMs > 0) {
      const limit = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new JobTimeout(`didn't finish in ${span(timeoutMs)}`)), timeoutMs);
      });
      await Promise.race([work, limit]);
    } else {
      await work;
    }
    await completeJob(ctx.db, job.id);
  } catch (err) {
    const retrying = await failJob(ctx.db, job, err);
    const reason = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    if (!retrying) {
      await emit(ctx.db, {
        kind: "job.failed",
        level: "error",
        message: `${job.type} failed: ${reason}`,
        data: { jobId: job.id },
        tenantId: job.tenantId,
      });
    } else if (err instanceof JobTimeout) {
      await emit(ctx.db, {
        kind: "job.timeout",
        level: "warn",
        message: `${job.type} ${reason}, so the queue moved on. It runs again shortly.`,
        data: { jobId: job.id },
        tenantId: job.tenantId,
      });
    }
  } finally {
    clearTimeout(timer);
  }
}

const minutes = (env: string | undefined, fallback: number) => Number(env ?? fallback) * 60_000;
const SCHEDULE = [
  { job: "sources.sweep", every: minutes(process.env.ELEVATE_SWEEP_MINUTES, 15), needsGitHub: false },
  // Cheap: one list call, plus a branch lookup only for repos that were pushed to.
  { job: "repos.sync", every: minutes(process.env.ELEVATE_SYNC_MINUTES, 2), needsGitHub: true },
  // Follows open swarm PRs: their checks, merges and closes on GitHub, and auto-merge when it's on.
  { job: "prs.track", every: prCheckMinutes() * 60_000, needsGitHub: true },
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
    // PGlite lets one process open a data dir, so a job still marked running was left by a process that's gone.
    // Requeue it now: until then its dedupe key would hold back the next one (a sweep, say).
    await recoverStaleJobs(ctx.db, 30, !process.env.DATABASE_URL);
    await resumeSwarms(ctx).catch((err) => console.error("resumeSwarms failed", err));
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
      // runJob records a job's own failure; this catches the rarer case where recording it failed, which would otherwise stop the worker.
      const crashed = (err: unknown) => console.error(`Worker: ${job.type} job ${job.id} couldn't be recorded`, err);
      if (job.type === "swarm.run") {
        const p: Promise<void> = runJob(ctx, job)
          .catch(crashed)
          .finally(() => swarmsRunning.delete(p));
        swarmsRunning.add(p);
      } else {
        await runJob(ctx, job).catch(crashed);
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
