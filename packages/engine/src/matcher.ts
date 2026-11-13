import { cosine } from "@elevate/agent";
import { and, emit, enqueue, eq, items, recommendations, repos, techniques } from "@elevate/db";
import { ECOSYSTEM_LABEL } from "@elevate/sources";
import { accessProfile, verdictFor } from "./access";
import type { Ctx } from "./context";
import { cuttingEdgeOnly, isCuttingEdge } from "./frontier";
import { watchedProfiledRepos } from "./profiler";
import { MATCH_SYSTEM, MatchSchema } from "./prompts";

const TOP_K = Number(process.env.ELEVATE_MATCH_TOP_K ?? 6);
const MIN_RELEVANCE = Number(process.env.ELEVATE_MIN_RELEVANCE ?? 0.5);

/**
 * Pair a technique that passed Gate 1 with the repos it could improve, and turn each plausible
 * pairing into a `candidate` recommendation that still has to pass Gate 2.
 */
export async function matchTechnique(ctx: Ctx, techniqueId: string, onlyRepoIds?: string[]) {
  const [tech] = await ctx.db.select().from(techniques).where(eq(techniques.id, techniqueId));
  if (!tech) throw new Error(`Technique ${techniqueId} not found`);
  if (!tech.legitimacy?.passed) return 0;
  // Don't recommend what the user can't act on: a replaced model version, or a product they don't have.
  const access = await accessProfile(ctx);
  if (!verdictFor(tech, access).usable) return 0;
  // Nor routine upkeep (a patch release, a database tip) while only cutting-edge ideas are wanted.
  if ((await cuttingEdgeOnly(ctx)) && !isCuttingEdge(tech)) return 0;

  const existing = new Set(
    (await ctx.db.select({ repoId: recommendations.repoId }).from(recommendations).where(eq(recommendations.techniqueId, techniqueId))).map(
      (r) => r.repoId,
    ),
  );
  // Repos whose own search surfaced this technique are always considered, ahead of embedding neighbours.
  const focused = new Map<string, string>();
  for (const i of await ctx.db.select({ signals: items.signals }).from(items).where(eq(items.techniqueId, techniqueId))) {
    for (const id of i.signals.focus?.repoIds ?? []) if (!focused.has(id)) focused.set(id, i.signals.focus!.query);
  }
  const candidates = (await watchedProfiledRepos(ctx, tech.tenantId))
    .filter((r) => !existing.has(r.id) && (!onlyRepoIds || onlyRepoIds.includes(r.id)))
    .map((r) => ({ repo: r, sim: tech.embedding && r.embedding ? cosine(tech.embedding, r.embedding) : 0, foundBy: focused.get(r.id) }))
    .sort((a, b) => Number(!!b.foundBy) - Number(!!a.foundBy) || b.sim - a.sim)
    .slice(0, TOP_K);
  if (!candidates.length) return 0;

  const result = await ctx.llm.json({
    task: "match",
    system: MATCH_SYSTEM,
    schema: MatchSchema,
    prompt: [
      `Technique: ${tech.name} (${tech.category})`,
      tech.summary,
      `Applies to: ${tech.claims.appliesTo.join(", ")}`,
      `Claimed benefits: ${tech.claims.claimedBenefits.join(", ")}`,
      `Prerequisites: ${tech.claims.prerequisites.join(", ") || "none"}`,
      ``,
      `The user has: ${access.ecosystems.map((e) => ECOSYSTEM_LABEL[e]).join(", ") || "no AI products connected"}.`,
      ...(access.available.length ? [`Models on their plan: ${access.available.map((m) => m.label).join(", ")}.`] : []),
      ``,
      `Repositories:`,
      ...candidates.map(
        (c) => `\n### ${c.repo.fullName}${c.foundBy ? `\n(This technique surfaced in a search for "${c.foundBy}" run for this repo.)` : ""}\n${c.repo.profileText}`,
      ),
    ].join("\n"),
  });

  const byName = new Map(candidates.map((c) => [c.repo.fullName.toLowerCase(), c.repo]));
  let created = 0;
  for (const m of result.matches) {
    const repo = byName.get(m.repo.toLowerCase());
    if (!repo || !m.applies || m.relevance < MIN_RELEVANCE) continue;
    const [row] = await ctx.db
      .insert(recommendations)
      .values({
        tenantId: tech.tenantId,
        techniqueId: tech.id,
        repoId: repo.id,
        title: m.title,
        relevance: m.relevance,
        hypothesis: {
          change: m.change,
          rationale: m.rationale,
          expectedImpact: m.expectedImpact,
          effort: m.effort,
          risk: m.risk,
          touchpoints: m.touchpoints,
        },
      })
      .onConflictDoNothing()
      .returning({ id: recommendations.id });
    if (!row) continue;
    created++;
    await enqueue(ctx.db, "recommendation.soundness", { recommendationId: row.id }, { dedupeKey: `recommendation.soundness:${row.id}` });
  }
  if (created) {
    await emit(ctx.db, { kind: "technique.matched", message: `${tech.name}: ${created} candidate change${created === 1 ? "" : "s"} to verify`, data: { techniqueId } });
  }
  return created;
}

/** A newly profiled repo is checked against every technique that already passed Gate 1. */
export async function matchRepo(ctx: Ctx, repoId: string, limit = 20) {
  const [repo] = await ctx.db.select({ tenantId: repos.tenantId }).from(repos).where(eq(repos.id, repoId));
  if (!repo) throw new Error(`Repo ${repoId} not found`);
  const onlyCuttingEdge = await cuttingEdgeOnly(ctx);
  const passed = (
    await ctx.db
      .select({ id: techniques.id, name: techniques.name, summary: techniques.summary, frontier: techniques.frontier, legitimacy: techniques.legitimacy, firstSeenAt: techniques.firstSeenAt })
      .from(techniques)
      .where(and(eq(techniques.tenantId, repo.tenantId)))
  )
    .filter((t) => t.legitimacy?.passed && (!onlyCuttingEdge || isCuttingEdge(t)))
    .sort((a, b) => b.firstSeenAt.getTime() - a.firstSeenAt.getTime())
    .slice(0, limit);
  let created = 0;
  for (const t of passed) created += await matchTechnique(ctx, t.id, [repoId]);
  return created;
}
