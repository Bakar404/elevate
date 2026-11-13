import { and, asc, auditLog, desc, eq, events, inArray, isNotNull, items, recommendations, repos, sources, sql, swarms, swarmTasks, techniques, threads, messages } from "@elevate/db";
import { defaultSources, ECOSYSTEM_LABEL, sourceEcosystem, sourceKey } from "@elevate/sources";
import { accessProfile, accessView } from "./access";
import type { Ctx } from "./context";
import { judgeRecs, subjectColumns, type Judgement } from "./feedback";
import { cuttingEdgeOnly, isCuttingEdge } from "./frontier";
import { focusQueries, TRIAGE_TRIES } from "./ingest";
import { autoMerge, prCheckMinutes, prNextStep, type PrNextStep, type SwarmPr } from "./prs";

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
      (select count(*)::int from recommendations r join repos p on p.id = r.repo_id where p.watch and r.status = 'merged') as merged,
      (select count(*)::int from swarms where status in ('queued','planning','running')) as "activeSwarms"
  `).then((r) => (Array.isArray(r) ? r : (r as { rows: Record<string, number>[] }).rows));
  // Open recommendations shown as filtered out (can't act on it, disliked, routine upkeep, or ones the user
  // usually passes on) aren't waiting on them.
  if (row) row.open = (await judgedOpen(ctx, { watchedOnly: true })).filter((r) => !r.held).length;
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
    merged: number;
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

/** A recommendation's pull request: the one its latest finished swarm opened, and what it's waiting on. */
export type RecPr = { swarmId: string; url: string; status: SwarmPr | null; next: PrNextStep };

const PR_STATUSES = ["pr_opened", "merged", "closed"] as const;

async function recPrs(ctx: Ctx, recs: { id: string; status: string; allowSwarm: boolean }[]) {
  const out = new Map<string, RecPr>();
  const ids = recs.filter((r) => (PR_STATUSES as readonly string[]).includes(r.status)).map((r) => r.id);
  if (!ids.length) return out;
  const rows = await ctx.db
    .select({ id: swarms.id, rec: swarms.recommendationId, prUrl: swarms.prUrl, result: swarms.result })
    .from(swarms)
    .where(and(inArray(swarms.recommendationId, ids), eq(swarms.status, "succeeded"), isNotNull(swarms.prUrl)))
    .orderBy(desc(swarms.createdAt));
  const auto = await autoMerge(ctx);
  for (const s of rows) {
    const rec = recs.find((r) => r.id === s.rec);
    if (!rec || out.has(s.rec)) continue;
    const status = (s.result as { pr?: SwarmPr } | null)?.pr ?? null;
    out.set(s.rec, { swarmId: s.id, url: s.prUrl!, status, next: prNextStep(status ?? undefined, { recStatus: rec.status, allowSwarm: rec.allowSwarm, autoMerge: auto }) });
  }
  return out;
}

export async function listRecommendations(ctx: Ctx, status?: string) {
  const rows = await ctx.db
    .select({ ...recColumns, ...subjectColumns })
    .from(recommendations)
    .innerJoin(repos, eq(recommendations.repoId, repos.id))
    .innerJoin(techniques, eq(recommendations.techniqueId, techniques.id))
    .where(and(eq(repos.watch, true), status ? eq(recommendations.status, status as never) : undefined))
    .orderBy(desc(recommendations.score), desc(recommendations.createdAt))
    .limit(200);
  const [prs, judged] = await Promise.all([recPrs(ctx, rows), judgeRecs(ctx, rows)]);
  const out = rows.map(({ techniqueSummary: _s, claims: _c, embedding: _e, frontier: _f, techniqueId: _t, ...r }) => {
    const pr = prs.get(r.id);
    const j = judged.get(r.id)!;
    return {
      ...r,
      /** Set when the user can't act on the technique any more (replaced model, product not connected). */
      blocked: j.blocked,
      /** Set on an open recommendation that is shown under Filtered out instead of Ready for review, with why. */
      held: j.held,
      /** The learner's estimate that the user would like it, and what in their votes moved it (null before any). */
      fit: j.fit,
      why: j.why,
      /** What its pull request is waiting on, while it has one. */
      pr: pr ? { swarmId: pr.swarmId, url: pr.url, next: pr.next } : null,
    };
  });
  return rankOpen(out, judged);
}

/** Ready-for-review recommendations go in the learner's order (Bayes-UCB); everything else keeps its place. */
function rankOpen<T extends { id: string; status: string }>(rows: T[], judged: Map<string, Judgement>) {
  const slots = rows.flatMap((r, i) => (r.status === "open" ? [i] : []));
  const ranked = slots.map((i) => rows[i]!).sort((a, b) => judged.get(b.id)!.rank - judged.get(a.id)!.rank);
  const out = [...rows];
  slots.forEach((slot, k) => (out[slot] = ranked[k]!));
  return out;
}

/** Every open recommendation and whether it is held back from Ready for review. */
async function judgedOpen(ctx: Ctx, opts: { watchedOnly?: boolean } = {}) {
  const rows = await ctx.db
    .select({ ...subjectColumns, repoId: repos.id })
    .from(recommendations)
    .innerJoin(repos, eq(recommendations.repoId, repos.id))
    .innerJoin(techniques, eq(recommendations.techniqueId, techniques.id))
    .where(and(eq(recommendations.status, "open"), opts.watchedOnly ? eq(repos.watch, true) : undefined));
  const judged = await judgeRecs(ctx, rows);
  return rows.map((r) => ({ id: r.id, repoId: r.repoId, held: judged.get(r.id)!.held }));
}

export async function getRecommendation(ctx: Ctx, id: string) {
  const [row] = await ctx.db
    .select({ ...recColumns, ...subjectColumns, repoUrl: repos.htmlUrl })
    .from(recommendations)
    .innerJoin(repos, eq(recommendations.repoId, repos.id))
    .innerJoin(techniques, eq(recommendations.techniqueId, techniques.id))
    .where(eq(recommendations.id, id));
  if (!row) return undefined;
  const { embedding: _e, ...rec } = row;
  const access = accessView({ name: rec.technique, summary: rec.techniqueSummary, claims: rec.claims }, await accessProfile(ctx));
  const [sourcesFor, swarmRows, judged] = await Promise.all([
    ctx.db
      .select({ title: items.title, url: items.url, source: sources.name, credibility: sources.credibility, points: items.signals })
      .from(items)
      .innerJoin(sources, eq(items.sourceId, sources.id))
      .where(eq(items.techniqueId, rec.techniqueId)),
    ctx.db.select().from(swarms).where(eq(swarms.recommendationId, id)).orderBy(desc(swarms.createdAt)),
    judgeRecs(ctx, [row]).then((m) => m.get(row.id)!),
  ]);
  const pr = (await recPrs(ctx, [rec])).get(rec.id) ?? null;
  return {
    ...rec,
    access,
    cuttingEdge: isCuttingEdge({ name: rec.technique, summary: rec.techniqueSummary, frontier: rec.frontier }),
    held: judged.held,
    fit: judged.fit,
    why: judged.why,
    items: sourcesFor,
    swarms: swarmRows,
    pr,
    autoMerge: await autoMerge(ctx),
  };
}

export async function listRepos(ctx: Ctx) {
  const rows = await ctx.db.select().from(repos).orderBy(desc(repos.pushedAt));
  const counts = await ctx.db
    .select({ repoId: recommendations.repoId, status: recommendations.status, n: sql<number>`count(*)::int` })
    .from(recommendations)
    .groupBy(recommendations.repoId, recommendations.status);
  const held = new Map<string, number>();
  for (const o of await judgedOpen(ctx)) if (o.held) held.set(o.repoId, (held.get(o.repoId) ?? 0) + 1);
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
      open: n("open") - (held.get(r.id) ?? 0),
      prs: n("pr_opened"),
      merged: n("merged"),
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
  const [repoRows, recRows, swarmRows, open] = await Promise.all([
    ctx.db
      .select({ id: repos.id, fullName: repos.fullName, language: repos.language, allowSwarm: repos.allowSwarm, pushedAt: repos.pushedAt })
      .from(repos)
      .where(eq(repos.watch, true)),
    ctx.db
      .select({ id: recommendations.id, repoId: recommendations.repoId, techniqueId: techniques.id, technique: techniques.name, category: techniques.category, status: recommendations.status, score: recommendations.score })
      .from(recommendations)
      .innerJoin(techniques, eq(recommendations.techniqueId, techniques.id)),
    ctx.db.select({ repoId: swarms.repoId, status: swarms.status }).from(swarms),
    judgedOpen(ctx, { watchedOnly: true }),
  ]);
  const held = new Set(open.filter((o) => o.held).map((o) => o.id));
  const live = recRows.filter((r) => LIVE_REC.has(r.status) && !held.has(r.id));
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
    .select({ id: recommendations.id, techniqueId: recommendations.techniqueId, status: recommendations.status })
    .from(recommendations)
    .innerJoin(repos, eq(recommendations.repoId, repos.id))
    .where(eq(repos.watch, true));
  const held = new Set((await judgedOpen(ctx, { watchedOnly: true })).filter((o) => o.held).map((o) => o.id));
  const access = await accessProfile(ctx);
  return techs.map((t) => ({
    access: accessView(t, access),
    id: t.id,
    name: t.name,
    summary: t.summary,
    category: t.category,
    novelty: t.novelty,
    /** False for routine upkeep (a patch release, a deprecation, a database tip), which isn't recommended while only cutting-edge ideas are. */
    cuttingEdge: isCuttingEdge(t),
    claims: t.claims,
    legitimacy: t.legitimacy,
    firstSeenAt: t.firstSeenAt,
    items: its.filter((i) => i.techniqueId === t.id).map(({ signals: _s, ...i }) => i),
    /** Repos whose own web search surfaced this technique. */
    foundFor: [...new Set(its.filter((i) => i.techniqueId === t.id).flatMap((i) => i.signals.focus?.repoIds ?? []))].map(name).filter(Boolean) as string[],
    matches: recs.filter((r) => r.techniqueId === t.id).length,
    open: recs.filter((r) => r.techniqueId === t.id && r.status === "open" && !held.has(r.id)).length,
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
/** `hideHype` drops items judged irrelevant, whose technique failed the legitimacy gate, or (while only cutting-edge ideas are wanted) is routine upkeep: for surfaces that should only show signal. */
export async function discoveryFeed(ctx: Ctx, opts: { limit?: number; repoOnly?: boolean; hideHype?: boolean } = {}) {
  const limit = opts.limit ?? 60;
  const rows = await ctx.db
    .select({
      id: items.id,
      title: items.title,
      url: items.url,
      status: items.status,
      lastError: items.lastError,
      attempts: items.attempts,
      signals: items.signals,
      publishedAt: items.publishedAt,
      createdAt: items.createdAt,
      source: sources.name,
      kind: sources.kind,
      techniqueId: items.techniqueId,
      technique: techniques.name,
      techniqueSummary: techniques.summary,
      claims: techniques.claims,
      frontier: techniques.frontier,
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
  const onlyCuttingEdge = await cuttingEdgeOnly(ctx);
  return rows
    .map(({ techniqueSummary, claims, frontier, ...r }) => ({
      ...r,
      /** Why the user can't act on this item's technique, if they can't. */
      blocked: r.technique ? accessView({ name: r.technique, summary: techniqueSummary ?? "", claims }, access).reason : null,
      /** True when its technique is routine upkeep rather than something new. */
      routine: r.technique ? !isCuttingEdge({ name: r.technique, summary: techniqueSummary, frontier }) : false,
    }))
    .filter((r) => !opts.hideHype || (!r.blocked && !(onlyCuttingEdge && r.routine)))
    .filter((r) => !opts.repoOnly || (r.signals.focus?.repoIds ?? []).some((id) => name(id)))
    .slice(0, limit)
    .map(({ signals, lastError, attempts, ...r }) => ({
    ...r,
    points: signals.points ?? null,
    stars: signals.stars ?? null,
    query: signals.focus?.query ?? null,
    repos: (signals.focus?.repoIds ?? []).map(name).filter(Boolean) as string[],
    /** Why the model couldn't classify this item, and whether a scheduled sweep will try again. */
    failed: r.status === "error" ? { reason: lastError ?? "no reason was recorded", retrying: attempts < TRIAGE_TRIES } : null,
  }));
}

/** What the next sweep will search for on behalf of the repos (shown so the targeting is inspectable). */
export async function searchPlan(ctx: Ctx) {
  const name = await repoNames(ctx);
  return (await focusQueries(ctx)).map((q) => ({ term: q.term, kind: q.kind, repos: q.repoIds.map(name).filter(Boolean) as string[] }));
}
export async function listSources(ctx: Ctx) {
  const builtIn = new Set(defaultSources().map((d) => sourceKey(d.url)));
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
      builtIn: s.url.startsWith("focus://") || s.url.startsWith("demo://") || builtIn.has(sourceKey(s.url)),
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
  const rows = await ctx.db
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
      recStatus: recommendations.status,
      repo: repos.fullName,
      allowSwarm: repos.allowSwarm,
      result: swarms.result,
    })
    .from(swarms)
    .innerJoin(recommendations, eq(swarms.recommendationId, recommendations.id))
    .innerJoin(repos, eq(swarms.repoId, repos.id))
    .orderBy(desc(swarms.createdAt))
    .limit(100);
  const auto = await autoMerge(ctx);
  // Like the PR tracker: each recommendation's latest finished swarm owns its PR.
  const owner = new Map<string, string>();
  for (const r of rows) if (r.status === "succeeded" && r.prUrl && !owner.has(r.recommendationId)) owner.set(r.recommendationId, r.id);
  return rows.map(({ result, ...r }) => {
    const pr = (result as { pr?: SwarmPr } | null)?.pr;
    const next =
      r.status === "succeeded" && r.prUrl
        ? prNextStep(pr, { recStatus: r.recStatus, allowSwarm: r.allowSwarm, autoMerge: auto, owns: owner.get(r.recommendationId) === r.id })
        : undefined;
    return { ...r, pr, next };
  });
}

export type SwarmRow = Awaited<ReturnType<typeof listSwarms>>[number];

export async function getSwarm(ctx: Ctx, id: string) {
  const [s] = (await listSwarms(ctx)).filter((x) => x.id === id);
  if (!s) return undefined;
  const [full] = await ctx.db.select({ budget: swarms.budget, result: swarms.result }).from(swarms).where(eq(swarms.id, id));
  const tasks = await ctx.db.select().from(swarmTasks).where(eq(swarmTasks.swarmId, id));
  const log = await ctx.db.select().from(events).where(eq(events.swarmId, id)).orderBy(asc(events.id)).limit(500);
  const audits = await ctx.db.select().from(auditLog).where(eq(auditLog.actor, `swarm:${id}`)).orderBy(asc(auditLog.id));
  return { ...s, ...full, tasks, events: log, audits, autoMerge: await autoMerge(ctx), prCheckMinutes: prCheckMinutes() };
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
