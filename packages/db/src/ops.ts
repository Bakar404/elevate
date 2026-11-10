import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { DB } from "./client";
import { auditLog, events, jobs, settings } from "./schema";

export type EnqueueOptions = { runAt?: Date; dedupeKey?: string; maxAttempts?: number; tenantId?: string };

/** Enqueue a job. With a dedupeKey, a second enqueue while one is queued/running is a no-op. */
export async function enqueue(db: DB, type: string, payload: Record<string, unknown> = {}, opts: EnqueueOptions = {}) {
  const rows = await db
    .insert(jobs)
    .values({
      type,
      payload,
      tenantId: opts.tenantId ?? "local",
      runAt: opts.runAt ?? new Date(),
      dedupeKey: opts.dedupeKey ?? null,
      maxAttempts: opts.maxAttempts ?? 3,
    })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return rows[0]?.id;
}

export type ClaimedJob = typeof jobs.$inferSelect;

/** Atomically claim the next ready job (safe with many workers on real Postgres). */
export async function claimJob(db: DB): Promise<ClaimedJob | undefined> {
  const result = await db.execute(sql`
    update jobs set status = 'running', locked_at = now(), attempts = attempts + 1
    where id = (
      select id from jobs
      where status = 'queued' and run_at <= now()
      order by run_at, id
      for update skip locked
      limit 1
    )
    returning id`);
  const rows = (result as unknown as { rows?: { id: number }[] }).rows ?? (result as unknown as { id: number }[]);
  const id = rows[0]?.id;
  if (id === undefined) return undefined;
  const [job] = await db.select().from(jobs).where(eq(jobs.id, Number(id)));
  return job;
}

export async function completeJob(db: DB, id: number) {
  await db.update(jobs).set({ status: "done", finishedAt: new Date(), lastError: null }).where(eq(jobs.id, id));
}

export async function failJob(db: DB, job: ClaimedJob, error: unknown) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  const retry = job.attempts < job.maxAttempts;
  await db
    .update(jobs)
    .set({
      status: retry ? "queued" : "failed",
      lastError: message.slice(0, 4000),
      runAt: retry ? new Date(Date.now() + 30_000 * 2 ** (job.attempts - 1)) : job.runAt,
      finishedAt: retry ? null : new Date(),
    })
    .where(eq(jobs.id, job.id));
  return retry;
}

/** Requeue jobs whose worker died mid-flight. */
export async function recoverStaleJobs(db: DB, staleMinutes = 30) {
  await db.execute(
    sql`update jobs set status = 'queued' where status = 'running' and locked_at < now() - (${staleMinutes} || ' minutes')::interval`,
  );
}

export type EventInput = {
  kind: string;
  message: string;
  level?: "info" | "success" | "warn" | "error";
  swarmId?: string | null;
  data?: Record<string, unknown>;
  tenantId?: string;
};

export async function emit(db: DB, e: EventInput) {
  await db.insert(events).values({
    kind: e.kind,
    message: e.message,
    level: e.level ?? "info",
    swarmId: e.swarmId ?? null,
    data: e.data ?? null,
    tenantId: e.tenantId ?? "local",
  });
}

export async function eventsSince(db: DB, afterId: number, swarmId?: string, limit = 200) {
  const where = swarmId ? and(gt(events.id, afterId), eq(events.swarmId, swarmId)) : gt(events.id, afterId);
  return db.select().from(events).where(where).orderBy(events.id).limit(limit);
}

export async function recentEvents(db: DB, limit = 50) {
  return db.select().from(events).orderBy(desc(events.id)).limit(limit);
}

export async function audit(
  db: DB,
  actor: string,
  action: string,
  target: string,
  details?: Record<string, unknown>,
  tenantId = "local",
) {
  await db.insert(auditLog).values({ actor, action, target, details: details ?? null, tenantId });
}

export async function getSetting<T>(db: DB, key: string, fallback: T, tenantId = "local"): Promise<T> {
  const [row] = await db
    .select()
    .from(settings)
    .where(and(eq(settings.tenantId, tenantId), eq(settings.key, key)));
  return row ? (row.value as T) : fallback;
}

export async function setSetting(db: DB, key: string, value: unknown, tenantId = "local") {
  await db
    .insert(settings)
    .values({ tenantId, key, value })
    .onConflictDoUpdate({ target: [settings.tenantId, settings.key], set: { value, updatedAt: new Date() } });
}
