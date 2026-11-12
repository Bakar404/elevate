import { and, asc, auditLog, desc, eq, events, items, recommendations, repos, sources, sql, swarms, swarmTasks, techniques, threads, messages } from "@elevate/db";
import { defaultSources, ECOSYSTEM_LABEL, sourceEcosystem } from "@elevate/sources";
import { accessProfile, accessView, verdictFor } from "./access";
import type { Ctx } from "./context";
import { focusQueries } from "./ingest";

/**
 * Read models for the UI. Everything the pages show comes from here. Repos the user turned off
 * (watch = false) only appear on the Repos page, where they can be turned back on; their
 * recommendations are kept and come back with them.
 */

export async function stats(ctx: Ctx) {
  const [row] = await ctx.db.execute<Record<string, number>>(sql`
    select
      (select count(*)::int from repos where watch) as repos,
      (select count(*)::int from repos where watch and allow_swarm) as "allowedRepos",
      (select count(*)::int from items) as items,
      (select count(*)::int from techniques) as techniques,
      (select count(*)::int from techniques where (legitimacy->>'passed')::boolean) as legit,
      (select count(*)::int from techniques where (legitimacy->>'passed')::boolean = false) as hype,
      (select count(*)::int from recommendations r join repos p on p.id = r.repo_id where p.watch and r.status = 'open') as open,
      (select count(*)::int from recommendations r join repos p on p.id = r.repo_id where p.watch and r.status = 'gated_out') as "gatedOut",
      (select count(*)::int from recommendations r join repos p on p.id = r.repo_id where p.watch and r.status = 'pr_opened') as prs,
      (select count(*)::int from swarms where status in ('queued','planning','running')) as "activeSwarms"
  `).then((r) => (Array.isArray(r) ? r : (r as { rows: Record<string, number>[] }).rows));
  // Open recommendations the user can no longer act on are shown as filtered, so don't count them as waiting.
  const access = await accessProfile(ctx);
  const openRecs = await ctx.db
    .select({ name: techniques.name, summary: techniques.summary, claims: techniques.claims })
    .from(recommendations)
    .innerJoin(repos, eq(recommendations.repoId, repos.id))
    .innerJoin(techniques, eq(recommendations.techniqueId, techniques.id))
    .where(and(eq(recommendations.status, "open"), eq(repos.watch, true)));
  const blocked = openRecs.filter((t) => !verdictFor(t, access).usable).length;
  if (row) row.open = Math.max(0, (row.open ?? 0) - blocked);
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
  const access = await accessProfile(ctx);
  const rows = await ctx.db
    .select({ ...recColumns, techniqueSummary: techniques.summary, claims: techniques.claims })
    .from(recommendations)
    .innerJoin(repos, eq(recommendations.repoId, repos.id))
    .innerJoin(techniques, eq(recommendations.techniqueId, techniques.id))
    .where(and(eq(repos.watch, true), status ? eq(recommendations.status, status as never) : undefined))
    .orderBy(desc(recommendations.score), desc(recommendations.createdAt))
    .limit(200);
  return rows.map(({ techniqueSummary, claims, ...r }) => ({
    ...r,
    /** Set when the user can't act on the technique any more (replaced model, product not connected). */
    blocked: accessView({ name: r.technique, summary: techniqueSummary, claims }, access).reason,
  }));
}

export async function getRecommendation(ctx: Ctx, id: string) {
  const [rec] = await ctx.db
    .select({ ...recColumns, techniqueId: techniques.id, techniqueSummary: techniques.summary, claims: techniques.claims, repoUrl: repos.htmlUrl })
    .from(recommendations)
    .innerJoin(repos, eq(recommendations.repoId, repos.id))
    .innerJoin(techniques, eq(recommendations.techniqueId, techniques.id))
    .where(eq(recommendations.id, id));
  if (!rec) return undefined;
  const access = accessView({ name: rec.technique, summary: rec.techniqueSummary, claims: rec.claims }, await accessProfile(ctx));
  const [sourcesFor, swarmRows] = await Promise.all([
    ctx.db
      .select({ title: items.title, url: items.url, source: sources.name, credibility: sources.credibility, points: items.signals })
      .from(items)
      .innerJoin(sources, eq(items.sourceId, sources.id))
      .where(eq(items.techniqueId, rec.techniqueId)),
    ctx.db.select().from(swarms).where(eq(swarms.recommendationId, id)).orderBy(desc(swarms.createdAt)),
  ]);
  return { ...rec, access, items: sourcesFor, swarms: swarmRows };
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
      profiledSha: r.profiledSha,
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
      .select({ id: repos.id, fullName: repos.fullName, language: repos.language, allowSwarm: repos.allowSwarm, pushedAt: repos.pushedAt })
      .from(repos)
      .where(eq(repos.watch, true)),
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
    .select({ techniqueId: items.techniqueId, title: items.title, url: items.url, source: sources.name, kind: sources.kind, signals: items.signals })
    .from(items)
    .innerJoin(sources, eq(items.sourceId, sources.id));
  const name = await repoNames(ctx);
  const recs = await ctx.db
    .select({ techniqueId: recommendations.techniqueId, status: recommendations.status })
    .from(recommendations)
    .innerJoin(repos, eq(recommendations.repoId, repos.id))
    .where(eq(repos.watch, true));
  const access = await accessProfile(ctx);
  return techs.map((t) => ({
    access: accessView(t, access),
    id: t.id,
    name: t.name,
    summary: t.summary,
    category: t.category,
    novelty: t.novelty,
    claims: t.claims,
    legitimacy: t.legitimacy,
    firstSeenAt: t.firstSeenAt,
    items: its.filter((i) => i.techniqueId === t.id).map(({ signals: _s, ...i }) => i),
    /** Repos whose own web search surfaced this technique. */
    foundFor: [...new Set(its.filter((i) => i.techniqueId === t.id).flatMap((i) => i.signals.focus?.repoIds ?? []))].map(name).filter(Boolean) as string[],
    matches: recs.filter((r) => r.techniqueId === t.id).length,
    open: recs.filter((r) => r.techniqueId === t.id && r.status === "open").length,
  }));
}

/** Names of watched repos by id; a turned-off repo resolves to undefined so it isn't shown. */
async function repoNames(ctx: Ctx) {
  const rows = await ctx.db.select({ id: repos.id, fullName: repos.fullName }).from(repos).where(eq(repos.watch, true));
  const m = new Map(rows.map((r) => [r.id, r.fullName]));
  return (id: string) => m.get(id);
}

export type FeedItem = Awaited<ReturnType<typeof discoveryFeed>>[number];

/** The latest things the sweep pulled in, newest first; `repoOnly` keeps just what a repo's own search found. */
/** `hideHype` drops items judged irrelevant or whose technique failed the legitimacy gate (for surfaces that should only show signal). */
export async function discoveryFeed(ctx: Ctx, opts: { limit?: number; repoOnly?: boolean; hideHype?: boolean } = {}) {
  const limit = opts.limit ?? 60;
  const rows = await ctx.db
    .select({
      id: items.id,
      title: items.title,
      url: items.url,
      status: items.status,
      signals: items.signals,
      publishedAt: items.publishedAt,
      createdAt: items.createdAt,
      source: sources.name,
      kind: sources.kind,
      techniqueId: items.techniqueId,
      technique: techniques.name,
      techniqueSummary: techniques.summary,
      claims: techniques.claims,
      legit: sql<boolean | null>`(${techniques.legitimacy}->>'passed')::boolean`,
    })
    .from(items)
    .innerJoin(sources, eq(items.sourceId, sources.id))
    .leftJoin(techniques, eq(items.techniqueId, techniques.id))
    .where(
      sql.join(
        [
          sql`true`,
          ...(opts.repoOnly ? [sql`${items.signals} ? 'focus'`] : []),
          ...(opts.hideHype ? [sql`${items.status} <> 'irrelevant'`, sql`coalesce((${techniques.legitimacy}->>'passed')::boolean, true)`] : []),
        ],
        sql` and `,
      ),
    )
    .orderBy(desc(items.createdAt), desc(items.publishedAt))
    // Over-fetch when filtering, since items the user can't act on (or found only for turned-off repos) are dropped below.
    .limit(opts.hideHype || opts.repoOnly ? limit * 3 : limit);
  const name = await repoNames(ctx);
  const access = await accessProfile(ctx);
  return rows
    .map(({ techniqueSummary, claims, ...r }) => ({
      ...r,
      /** Why the user can't act on this item's technique, if they can't. */
      blocked: r.technique ? accessView({ name: r.technique, summary: techniqueSummary ?? "", claims }, access).reason : null,
    }))
    .filter((r) => !opts.hideHype || !r.blocked)
    .filter((r) => !opts.repoOnly || (r.signals.focus?.repoIds ?? []).some((id) => name(id)))
    .slice(0, limit)
    .map(({ signals, ...r }) => ({
    ...r,
    points: signals.points ?? null,
    stars: signals.stars ?? null,
    query: signals.focus?.query ?? null,
    repos: (signals.focus?.repoIds ?? []).map(name).filter(Boolean) as string[],
  }));
}

/** What the next sweep will search for on behalf of the repos (shown so the targeting is inspectable). */
export async function searchPlan(ctx: Ctx) {
  const name = await repoNames(ctx);
  return (await focusQueries(ctx)).map((q) => ({ term: q.term, kind: q.kind, repos: q.repoIds.map(name).filter(Boolean) as string[] }));
}
export async function listSources(ctx: Ctx) {
  const builtIn = new Set(defaultSources().map((d) => d.url.replace(/created_at_i>\d+/, "")));
  const counts = await ctx.db
    .select({ sourceId: items.sourceId, n: sql<number>`count(*)::int`, kept: sql<number>`count(*) filter (where ${items.status} = 'triaged')::int` })
    .from(items)
    .groupBy(items.sourceId);
  const rows = await ctx.db.select().from(sources).orderBy(desc(sources.credibility));
  const have = new Set((await accessProfile(ctx)).ecosystems);
  return rows.map((s) => {
    const c = counts.find((x) => x.sourceId === s.id);
    const eco = sourceEcosystem(s);
    return {
      ...s,
      /** Set when the feed is about a product the user doesn't have, so sweeps skip it. */
      paused: eco && !have.has(eco) ? `Skipped: you haven't connected ${ECOSYSTEM_LABEL[eco]}` : null,
      /** Built-in sources come back on every sweep, so they can be switched off but not removed. */
      builtIn: s.url.startsWith("focus://") || s.url.startsWith("demo://") || builtIn.has(s.url.replace(/created_at_i>\d+/, "")),
      items: c?.n ?? 0,
      /** How many of its items turned out to describe a technique: a feed with many items and none kept is noise. */
      kept: c?.kept ?? 0,
    };
  });
}

/** Add an RSS/Atom feed of the user's own. */
export async function addSource(ctx: Ctx, input: { name: string; url: string; credibility?: number }, tenantId = "local") {
  const url = new URL(input.url);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Feed URL must start with http:// or https://");
  const [row] = await ctx.db
    .insert(sources)
    .values({ tenantId, kind: "rss", name: input.name.trim().slice(0, 80), url: url.toString(), credibility: input.credibility ?? 50, config: { custom: true } })
    .onConflictDoNothing()
    .returning();
  if (!row) throw new Error("That feed is already on the list");
  return row;
}

export async function updateSource(ctx: Ctx, id: string, patch: { enabled?: boolean; credibility?: number }) {
  const [row] = await ctx.db.update(sources).set(patch).where(eq(sources.id, id)).returning();
  if (!row) throw new Error("Source not found");
  return row;
}

/** Only sources the user added can be removed; their items go with them. */
export async function removeSource(ctx: Ctx, id: string) {
  const row = (await listSources(ctx)).find((s) => s.id === id);
  if (!row) throw new Error("Source not found");
  if (row.builtIn) throw new Error("Built-in sources can be switched off, not removed");
  await ctx.db.delete(sources).where(eq(sources.id, id));
  return { removed: true };
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
