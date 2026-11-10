import { asc, auditLog, desc, eq, events, items, recommendations, repos, sources, sql, swarms, swarmTasks, techniques, threads, messages } from "@elevate/db";
import type { Ctx } from "./context";

/** Read models for the UI. Everything the pages show comes from here. */

export async function stats(ctx: Ctx) {
  const [row] = await ctx.db.execute<Record<string, number>>(sql`
    select
      (select count(*)::int from repos) as repos,
      (select count(*)::int from repos where allow_swarm) as "allowedRepos",
      (select count(*)::int from items) as items,
      (select count(*)::int from techniques) as techniques,
      (select count(*)::int from techniques where (legitimacy->>'passed')::boolean) as legit,
      (select count(*)::int from techniques where (legitimacy->>'passed')::boolean = false) as hype,
      (select count(*)::int from recommendations where status = 'open') as open,
      (select count(*)::int from recommendations where status = 'gated_out') as "gatedOut",
      (select count(*)::int from recommendations where status = 'pr_opened') as prs,
      (select count(*)::int from swarms where status in ('queued','planning','running')) as "activeSwarms"
  `).then((r) => (Array.isArray(r) ? r : (r as { rows: Record<string, number>[] }).rows));
  return row as {
    repos: number;
    allowedRepos: number;
    items: number;
    techniques: number;
    legit: number;
    hype: number;
    open: number;
    gatedOut: number;
    prs: number;
    activeSwarms: number;
  };
}

const recColumns = {
  id: recommendations.id,
  title: recommendations.title,
  status: recommendations.status,
  score: recommendations.score,
  relevance: recommendations.relevance,
  hypothesis: recommendations.hypothesis,
  gate1: recommendations.gate1,
  gate2: recommendations.gate2,
  history: recommendations.history,
  createdAt: recommendations.createdAt,
  repo: repos.fullName,
  repoId: repos.id,
  allowSwarm: repos.allowSwarm,
  technique: techniques.name,
  category: techniques.category,
};

export type RecommendationRow = Awaited<ReturnType<typeof listRecommendations>>[number];

export async function listRecommendations(ctx: Ctx, status?: string) {
  return ctx.db
    .select(recColumns)
    .from(recommendations)
    .innerJoin(repos, eq(recommendations.repoId, repos.id))
    .innerJoin(techniques, eq(recommendations.techniqueId, techniques.id))
    .where(status ? eq(recommendations.status, status as never) : undefined)
    .orderBy(desc(recommendations.score), desc(recommendations.createdAt))
    .limit(200);
}

export async function getRecommendation(ctx: Ctx, id: string) {
  const [rec] = await ctx.db
    .select({ ...recColumns, techniqueId: techniques.id, techniqueSummary: techniques.summary, claims: techniques.claims, repoUrl: repos.htmlUrl })
    .from(recommendations)
    .innerJoin(repos, eq(recommendations.repoId, repos.id))
    .innerJoin(techniques, eq(recommendations.techniqueId, techniques.id))
    .where(eq(recommendations.id, id));
  if (!rec) return undefined;
  const [sourcesFor, swarmRows] = await Promise.all([
    ctx.db
      .select({ title: items.title, url: items.url, source: sources.name, credibility: sources.credibility, points: items.signals })
      .from(items)
      .innerJoin(sources, eq(items.sourceId, sources.id))
      .where(eq(items.techniqueId, rec.techniqueId)),
    ctx.db.select().from(swarms).where(eq(swarms.recommendationId, id)).orderBy(desc(swarms.createdAt)),
  ]);
  return { ...rec, items: sourcesFor, swarms: swarmRows };
}

export async function listRepos(ctx: Ctx) {
  const rows = await ctx.db.select().from(repos).orderBy(desc(repos.pushedAt));
  const counts = await ctx.db
    .select({ repoId: recommendations.repoId, status: recommendations.status, n: sql<number>`count(*)::int` })
    .from(recommendations)
    .groupBy(recommendations.repoId, recommendations.status);
  return rows.map((r) => {
    const mine = counts.filter((c) => c.repoId === r.id);
    const n = (s: string) => mine.find((c) => c.status === s)?.n ?? 0;
    return {
      id: r.id,
      fullName: r.fullName,
      description: r.description,
      language: r.language,
      topics: r.topics,
      stars: r.stars,
      isPrivate: r.isPrivate,
      htmlUrl: r.htmlUrl,
      pushedAt: r.pushedAt,
      watch: r.watch,
      allowSwarm: r.allowSwarm,
      profile: r.profile,
      profiledAt: r.profiledAt,
      open: n("open"),
      prs: n("pr_opened"),
    };
  });
}

const LIVE_REC = new Set(["candidate", "open", "approved", "in_progress", "pr_opened"]);
const ACTIVE_SWARM = new Set(["queued", "planning", "running"]);

export type GraphRepoState = "working" | "review" | "watched";
export type ActivityGraph = Awaited<ReturnType<typeof activityGraph>>;

/**
 * The home-screen map: watched repos (busiest first), the techniques currently matched to them,
 * and one link per live recommendation. "working" = a swarm is running on the repo, "review" =
 * a recommendation awaits approval.
 */
export async function activityGraph(ctx: Ctx, maxRepos = 12, maxTechniques = 8) {
  const [repoRows, recRows, swarmRows] = await Promise.all([
    ctx.db
      .select({ id: repos.id, fullName: repos.fullName, language: repos.language, watch: repos.watch, allowSwarm: repos.allowSwarm, pushedAt: repos.pushedAt })
      .from(repos),
    ctx.db
      .select({ id: recommendations.id, repoId: recommendations.repoId, techniqueId: techniques.id, technique: techniques.name, category: techniques.category, status: recommendations.status, score: recommendations.score })
      .from(recommendations)
      .innerJoin(techniques, eq(recommendations.techniqueId, techniques.id)),
    ctx.db.select({ repoId: swarms.repoId, status: swarms.status }).from(swarms),
  ]);
  const live = recRows.filter((r) => LIVE_REC.has(r.status));
  const working = new Set(swarmRows.filter((s) => ACTIVE_SWARM.has(s.status)).map((s) => s.repoId));
  for (const r of live) if (r.status === "approved" || r.status === "in_progress") working.add(r.repoId);

  const ranked = repoRows
    .map((r) => {
      const mine = live.filter((l) => l.repoId === r.id);
      const open = mine.filter((l) => l.status === "open").length;
      const state: GraphRepoState = working.has(r.id) ? "working" : open ? "review" : "watched";
      return { ...r, mine, open, prs: mine.filter((l) => l.status === "pr_opened").length, state };
    })
    .filter((r) => r.watch || r.allowSwarm || r.mine.length)
    .sort(
      (a, b) =>
        Number(b.state === "working") - Number(a.state === "working") ||
        b.open - a.open ||
        b.mine.length - a.mine.length ||
        Number(b.allowSwarm) - Number(a.allowSwarm) ||
        (b.pushedAt?.getTime() ?? 0) - (a.pushedAt?.getTime() ?? 0),
    );
  const shown = ranked.slice(0, maxRepos);
  const shownIds = new Set(shown.map((r) => r.id));

  const techCount = new Map<string, { id: string; name: string; category: string | null; n: number }>();
  for (const l of live) {
    if (!shownIds.has(l.repoId)) continue;
    const t = techCount.get(l.techniqueId) ?? { id: l.techniqueId, name: l.technique, category: l.category, n: 0 };
    t.n++;
    techCount.set(l.techniqueId, t);
  }
  const techs = [...techCount.values()].sort((a, b) => b.n - a.n).slice(0, maxTechniques);
  const techIds = new Set(techs.map((t) => t.id));

  return {
    repos: shown.map((r) => ({
      id: r.id,
      name: r.fullName.split("/").pop() ?? r.fullName,
      fullName: r.fullName,
      language: r.language,
      state: r.state,
      open: r.open,
      prs: r.prs,
    })),
    techniques: techs.map(({ id, name, category }) => ({ id, name, category })),
    links: live
      .filter((l) => shownIds.has(l.repoId) && techIds.has(l.techniqueId))
      .map((l) => ({ id: l.id, repoId: l.repoId, techniqueId: l.techniqueId, status: l.status, score: l.score })),
    hidden: Math.max(0, ranked.length - shown.length),
  };
}

export async function radar(ctx: Ctx) {
  const techs = await ctx.db.select().from(techniques).orderBy(desc(techniques.firstSeenAt)).limit(200);
  const its = await ctx.db
    .select({ techniqueId: items.techniqueId, title: items.title, url: items.url, source: sources.name, kind: sources.kind })
    .from(items)
    .innerJoin(sources, eq(items.sourceId, sources.id));
  const recs = await ctx.db
    .select({ techniqueId: recommendations.techniqueId, status: recommendations.status })
    .from(recommendations);
  return techs.map((t) => ({
    id: t.id,
    name: t.name,
    summary: t.summary,
    category: t.category,
    novelty: t.novelty,
    claims: t.claims,
    legitimacy: t.legitimacy,
    firstSeenAt: t.firstSeenAt,
    items: its.filter((i) => i.techniqueId === t.id),
    matches: recs.filter((r) => r.techniqueId === t.id).length,
    open: recs.filter((r) => r.techniqueId === t.id && r.status === "open").length,
  }));
}

export async function listSources(ctx: Ctx) {
  return ctx.db.select().from(sources).orderBy(desc(sources.credibility));
}

export async function listSwarms(ctx: Ctx) {
  return ctx.db
    .select({
      id: swarms.id,
      status: swarms.status,
      executor: swarms.executor,
      branch: swarms.branch,
      prUrl: swarms.prUrl,
      issueUrl: swarms.issueUrl,
      error: swarms.error,
      createdAt: swarms.createdAt,
      startedAt: swarms.startedAt,
      finishedAt: swarms.finishedAt,
      title: recommendations.title,
      recommendationId: recommendations.id,
      repo: repos.fullName,
    })
    .from(swarms)
    .innerJoin(recommendations, eq(swarms.recommendationId, recommendations.id))
    .innerJoin(repos, eq(swarms.repoId, repos.id))
    .orderBy(desc(swarms.createdAt))
    .limit(100);
}

export async function getSwarm(ctx: Ctx, id: string) {
  const [s] = (await listSwarms(ctx)).filter((x) => x.id === id);
  if (!s) return undefined;
  const [full] = await ctx.db.select({ budget: swarms.budget, result: swarms.result }).from(swarms).where(eq(swarms.id, id));
  const tasks = await ctx.db.select().from(swarmTasks).where(eq(swarmTasks.swarmId, id));
  const log = await ctx.db.select().from(events).where(eq(events.swarmId, id)).orderBy(asc(events.id)).limit(500);
  const audits = await ctx.db.select().from(auditLog).where(eq(auditLog.actor, `swarm:${id}`)).orderBy(asc(auditLog.id));
  return { ...s, ...full, tasks, events: log, audits };
}

export async function listThreads(ctx: Ctx) {
  return ctx.db.select().from(threads).orderBy(desc(threads.updatedAt)).limit(50);
}

export async function threadMessages(ctx: Ctx, threadId: string) {
  return ctx.db.select().from(messages).where(eq(messages.threadId, threadId)).orderBy(asc(messages.createdAt));
}

export async function recentAudit(ctx: Ctx, limit = 50) {
  return ctx.db.select().from(auditLog).orderBy(desc(auditLog.id)).limit(limit);
}
