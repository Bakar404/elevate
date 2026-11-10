import { and, audit, eq, recommendations, type DB } from "@elevate/db";
import { replay, transition, type LifecycleEvent, type Status } from "@elevate/policy";

export class LifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleError";
  }
}

type RecUpdate = Partial<Pick<typeof recommendations.$inferInsert, "gate1" | "gate2" | "score" | "decidedAt">>;

/**
 * The only way a recommendation's status changes. The next status comes from
 * the proved `transition` (T1–T6), the stored history must replay to the
 * stored status (T7), and the update is conditional on the status we read,
 * so a concurrent change can't be overwritten.
 */
export async function applyEvent(db: DB, recommendationId: string, event: LifecycleEvent, set: RecUpdate = {}, actor = "system") {
  const [rec] = await db
    .select({ status: recommendations.status, history: recommendations.history })
    .from(recommendations)
    .where(eq(recommendations.id, recommendationId));
  if (!rec) throw new LifecycleError(`Recommendation ${recommendationId} not found`);
  const replayed = replay(rec.history);
  if (replayed !== rec.status) {
    throw new LifecycleError(`History of ${recommendationId} replays to ${replayed ?? "nothing"}, not ${rec.status}; refusing to continue`);
  }
  const next = transition(rec.status as Status, event);
  if (!next) throw new LifecycleError(`Can't ${event} a recommendation that is ${rec.status}`);

  const updated = await db
    .update(recommendations)
    .set({ ...set, status: next, history: [...rec.history, event], updatedAt: new Date() })
    .where(and(eq(recommendations.id, recommendationId), eq(recommendations.status, rec.status)))
    .returning({ id: recommendations.id });
  if (updated.length === 0) throw new LifecycleError(`Recommendation ${recommendationId} changed concurrently`);
  await audit(db, actor, `recommendation.${event}`, recommendationId, { from: rec.status, to: next });
  return next;
}
