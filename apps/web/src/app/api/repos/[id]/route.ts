import { and, audit, enqueue, eq, recommendations, repos } from "@elevate/db";
import { z } from "zod";
import { body, route } from "@/lib/api";

const Patch = z.object({ watch: z.boolean().optional(), allowSwarm: z.boolean().optional() });

export const PATCH = route(async (ctx, req, { id }) => {
  const p = Patch.parse(await body(req));
  const [r] = await ctx.db.update(repos).set({ ...p, updatedAt: new Date() }).where(eq(repos.id, id!)).returning();
  if (!r) throw new Error("Repo not found");
  if (p.allowSwarm !== undefined) await audit(ctx.db, "user", "repo.allow_swarm", r.fullName, { allowSwarm: p.allowSwarm });
  if (p.watch && !r.profiledAt) await enqueue(ctx.db, "repo.profile", { repoId: r.id }, { dedupeKey: `repo.profile:${r.id}` });
  if (p.watch) {
    // Gate 2 skips repos that are off, so check whatever was left waiting while this one was off.
    const waiting = await ctx.db
      .select({ id: recommendations.id })
      .from(recommendations)
      .where(and(eq(recommendations.repoId, r.id), eq(recommendations.status, "candidate")));
    for (const w of waiting) {
      await enqueue(ctx.db, "recommendation.soundness", { recommendationId: w.id }, { dedupeKey: `recommendation.soundness:${w.id}` });
    }
  }
  return { id: r.id, watch: r.watch, allowSwarm: r.allowSwarm };
});
