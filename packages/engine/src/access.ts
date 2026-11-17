import { and, desc, enqueue, eq, getSetting, gte, inArray, isNotNull, isNull, items, jobs, or, repos, sources, recommendations, setSetting, sql, techniques, type GateResult } from "@elevate/db";
import {
  ECOSYSTEMS,
  ECOSYSTEM_LABEL,
  findModels,
  isEcosystem,
  judgeAccess,
  techniqueTags,
  type Access,
  type AccessVerdict,
  type Ecosystem,
  type ModelRef,
} from "@elevate/sources";
import type { ModelOption } from "@elevate/agent";
import type { Ctx } from "./context";
import { resolveModelConfig } from "./context";
import { cuttingEdgeOnly, isCuttingEdge } from "./frontier";
import { GATE_CALIBRATION } from "./gates";
import { applyEvent, LifecycleError } from "./lifecycle";
import { availableModels } from "./models";

export type AccessOverrides = Partial<Record<Ecosystem, boolean>>;

export type AccessProfile = Access & {
  provider: string;
  /** What the connection itself implies, before the user's own switches. */
  detected: Ecosystem[];
  overrides: AccessOverrides;
  /** True when the provider's model list is live, so "not on your plan" can be judged. */
  listed: boolean;
};

const VENDOR: Record<string, Ecosystem> = { openai: "openai", azure: "openai", "azure openai": "openai", anthropic: "anthropic", google: "google", xai: "xai" };

/** The vendor a listed model belongs to: what the runtime says, else what its id says. */
function vendorOf(m: ModelOption): Ecosystem | undefined {
  return VENDOR[(m.vendor ?? "").toLowerCase()] ?? findModels(`${m.id} ${m.name}`)[0]?.ecosystem;
}

/** What a connection implies: the provider, the vendors on its model list, and an explicitly chosen executor. */
export function detectAccess(provider: string, models: ModelOption[], executor?: string, localAgent?: string): Ecosystem[] {
  const out = new Set<Ecosystem>();
  if (provider === "anthropic") out.add("anthropic").add("claude-code");
  else if (provider === "openai") out.add("openai").add("codex");
  else if (provider === "azure") out.add("openai");
  else {
    out.add("copilot");
    const enabled = models.filter((m) => m.enabled && m.id !== "auto");
    // No list (offline, or the runtime couldn't say): assume the vendors Copilot normally carries.
    if (!enabled.length) out.add("openai").add("anthropic").add("google");
    for (const m of enabled) {
      const v = vendorOf(m);
      if (v) out.add(v);
    }
  }
  const agent = executor === "local" ? localAgent : executor;
  if (agent === "claude-action" || agent === "claude") out.add("claude-code").add("anthropic");
  if (agent === "codex-cloud" || agent === "codex") out.add("codex").add("openai");
  if (agent === "copilot-cloud" && provider === "copilot") out.add("copilot");
  return ECOSYSTEMS.filter((e) => out.has(e));
}

const CACHE_MS = 10_000;
const LIST_TIMEOUT_MS = 4000;
const ANNOUNCER_CREDIBILITY = 70;
// On globalThis: the web app bundles this module more than once (pages and API routes), and a
// settings change made through one copy has to clear the profile the other copy is showing.
const CACHE_KEY = Symbol.for("elevate.access");
type G = typeof globalThis & { [CACHE_KEY]?: WeakMap<object, { at: number; value: Promise<AccessProfile> }> };
const cache = ((globalThis as G)[CACHE_KEY] ??= new WeakMap());

export function resetAccessCache(ctx: Ctx) {
  cache.delete(ctx.db as object);
}

/** What the user can actually use: drives which news is worth showing and matching. */
export function accessProfile(ctx: Ctx): Promise<AccessProfile> {
  const hit = cache.get(ctx.db as object);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = buildAccess(ctx).catch((err) => {
    cache.delete(ctx.db as object);
    throw err;
  });
  cache.set(ctx.db as object, { at: Date.now(), value });
  return value;
}

async function buildAccess(ctx: Ctx): Promise<AccessProfile> {
  const [{ provider }, catalog, executor, overrides, techRows, itemRows] = await Promise.all([
    ctx.demo ? Promise.resolve({ provider: "copilot" as const }) : resolveModelConfig(ctx.db),
    // Listing models can mean starting the Copilot runtime. A page shouldn't wait on that: without a
    // list the profile is permissive, and the next build (the cache is short) picks the list up.
    Promise.race([availableModels(ctx), new Promise<{ models: ModelOption[] }>((r) => setTimeout(() => r({ models: [] }), LIST_TIMEOUT_MS))]),
    getSetting<string | undefined>(ctx.db, "executor.default", undefined),
    getSetting<AccessOverrides>(ctx.db, "access.overrides", {}),
    ctx.db.select({ name: techniques.name, claims: techniques.claims }).from(techniques),
    // Titles only from outlets credible enough to announce a release; a forum rumour mustn't retire a model.
    ctx.db
      .select({ title: items.title })
      .from(items)
      .innerJoin(sources, eq(items.sourceId, sources.id))
      .where(gte(sources.credibility, ANNOUNCER_CREDIBILITY))
      .orderBy(desc(items.createdAt))
      .limit(3000),
  ]);
  const usable = catalog.models.filter((m) => m.enabled && m.id !== "auto");
  const available = findModels(usable.map((m) => m.id).join("\n"));
  const detected = detectAccess(provider, catalog.models, executor, process.env.ELEVATE_LOCAL_AGENT);
  const ecosystems = ECOSYSTEMS.filter((e) => overrides[e] ?? detected.includes(e));
  const seen = [...techRows.map((t) => `${t.name}\n${(t.claims?.models ?? []).join("\n")}`), ...itemRows.map((i) => i.title)].join("\n");
  const known = new Map<string, ModelRef>();
  for (const m of [...findModels(catalog.models.map((m) => m.id).join("\n")), ...findModels(seen)]) known.set(m.label, m);
  return { provider, detected, overrides, ecosystems, available, known: [...known.values()], listed: provider === "copilot" && available.length > 0 };
}

export async function setAccessOverrides(ctx: Ctx, overrides: Record<string, boolean | null>) {
  const next: AccessOverrides = { ...(await getSetting<AccessOverrides>(ctx.db, "access.overrides", {})) };
  for (const [k, v] of Object.entries(overrides)) {
    if (!isEcosystem(k)) continue;
    if (v === null) delete next[k];
    else next[k] = v;
  }
  await setSetting(ctx.db, "access.overrides", next);
  resetAccessCache(ctx);
  return next;
}

type Taggable = { name: string; summary?: string; claims?: { requires?: string[]; models?: string[] } | null };

export function verdictFor(t: Taggable, access: Access): AccessVerdict {
  return judgeAccess(techniqueTags(t), access);
}

/** Tags and verdict in the shape the UI shows. */
export function accessView(t: Taggable, access: Access) {
  const tags = techniqueTags(t);
  const verdict = judgeAccess(tags, access);
  return {
    requires: tags.requires.map((e) => ({ id: e, label: ECOSYSTEM_LABEL[e] })),
    models: tags.models.map((m) => m.label),
    usable: verdict.usable,
    kind: verdict.usable ? null : verdict.kind,
    reason: verdict.usable ? null : verdict.reason,
  };
}

/**
 * After the user's access or the cutting-edge setting changes, pick up what was held back: techniques
 * that were never checked go to Gate 1, and ones that already passed are matched against the repos.
 */
export async function recheckAccess(ctx: Ctx, tenantId = "local") {
  resetAccessCache(ctx);
  const access = await accessProfile(ctx);
  const onlyCuttingEdge = await cuttingEdgeOnly(ctx);
  const rows = await ctx.db.select().from(techniques).where(eq(techniques.tenantId, tenantId));
  const matched = new Set((await ctx.db.select({ id: recommendations.techniqueId }).from(recommendations)).map((r) => r.id));
  let queued = 0;
  for (const t of rows) {
    if (!verdictFor(t, access).usable) continue;
    if (onlyCuttingEdge && !isCuttingEdge(t)) continue;
    if (!t.legitimacy) {
      await enqueue(ctx.db, "technique.legitimacy", { techniqueId: t.id }, { dedupeKey: `technique.legitimacy:${t.id}` });
      queued++;
    } else if (t.legitimacy.passed && !matched.has(t.id)) {
      await enqueue(ctx.db, "technique.match", { techniqueId: t.id }, { dedupeKey: `technique.match:${t.id}` });
      queued++;
    }
  }
  return queued;
}

/** Reviews queued per sweep: a backlog clears within a few sweeps, without a burst of model calls. */
export const REVIEW_BATCH = 30;
/** How far back a verdict from an older gate calibration still gets its one more look. */
export const REVIEW_DAYS = 14;

/**
 * Run with every sweep, so nothing new goes unexamined. Up to `limit`, in order:
 * 1. candidates stuck before Gate 2 (their check was never queued, so "Verifying…" would never end);
 * 2. techniques that never got a Gate 1 review (one queued at the end of a triage run that didn't finish is lost);
 * 3. recent techniques Gate 1 judged under an older calibration, newest first;
 * 4. recent recommendations Gate 2 filtered out under an older calibration, once their technique has passed under
 *    the current one (or is too old to be looked at again), so the re-check sees its current legitimacy.
 * Only what the user can act on (and only cutting-edge ideas while that's on), each at most once per calibration,
 * and never one whose review job gave up since it was last judged. Returns how many it queued.
 */
export async function reviewDue(ctx: Ctx, tenantId = "local", limit = REVIEW_BATCH) {
  const access = await accessProfile(ctx);
  const onlyCuttingEdge = await cuttingEdgeOnly(ctx);
  const since = new Date(Date.now() - REVIEW_DAYS * 86_400_000);
  const wanted = (t: Taggable & { frontier: boolean | null }) => verdictFor(t, access).usable && (!onlyCuttingEdge || isCuttingEdge(t));
  const current = (verdict: GateResult | null) => (verdict?.calibration ?? 0) >= GATE_CALIBRATION;
  const stale = (verdict: typeof techniques.legitimacy | typeof recommendations.gate2) =>
    sql`coalesce((${verdict}->>'calibration')::int, 0) < ${GATE_CALIBRATION}`;

  // When each review job last gave up for good: queueing one that keeps failing again would loop every sweep.
  const gaveUp = new Map<string, Date>();
  for (const j of await ctx.db
    .select({ type: jobs.type, payload: jobs.payload, finishedAt: jobs.finishedAt })
    .from(jobs)
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.status, "failed"), inArray(jobs.type, ["technique.legitimacy", "recommendation.soundness"])))) {
    const key = `${j.type}:${String(j.payload.techniqueId ?? j.payload.recommendationId)}`;
    const prev = gaveUp.get(key);
    if (j.finishedAt && (!prev || j.finishedAt > prev)) gaveUp.set(key, j.finishedAt);
  }
  const gaveUpSince = (key: string, judged: Date | null) => {
    const at = gaveUp.get(key);
    return !!at && (!judged || at > judged);
  };
  const judgedAt = (verdict: GateResult | null) => (verdict ? new Date(verdict.checkedAt) : null);

  let queued = 0;
  const review = async (id: string) => {
    if (await enqueue(ctx.db, "technique.legitimacy", { techniqueId: id }, { dedupeKey: `technique.legitimacy:${id}`, tenantId })) queued++;
  };
  const check = async (id: string) => {
    if (await enqueue(ctx.db, "recommendation.soundness", { recommendationId: id }, { dedupeKey: `recommendation.soundness:${id}`, tenantId })) queued++;
  };
  const techColumns = { name: techniques.name, summary: techniques.summary, claims: techniques.claims, frontier: techniques.frontier, legitimacy: techniques.legitimacy };
  const recsIn = (status: "candidate" | "gated_out") =>
    ctx.db
      .select({ id: recommendations.id, gate2: recommendations.gate2, updatedAt: recommendations.updatedAt, tech: { ...techColumns, firstSeenAt: techniques.firstSeenAt } })
      .from(recommendations)
      .innerJoin(repos, eq(recommendations.repoId, repos.id))
      .innerJoin(techniques, eq(recommendations.techniqueId, techniques.id))
      .where(
        and(
          eq(recommendations.tenantId, tenantId),
          eq(recommendations.status, status),
          eq(repos.watch, true),
          ...(status === "gated_out" ? [gte(recommendations.createdAt, since), stale(recommendations.gate2)] : []),
        ),
      )
      .orderBy(desc(recommendations.createdAt));

  for (const r of await recsIn("candidate")) {
    if (queued >= limit) return queued;
    if (wanted(r.tech) && !gaveUpSince(`recommendation.soundness:${r.id}`, r.updatedAt)) await check(r.id);
  }

  // Ones classify hasn't sorted yet wait for it: the sweep queues it right before this.
  const techs = (
    await ctx.db
      .select({ id: techniques.id, ...techColumns })
      .from(techniques)
      .where(
        and(
          eq(techniques.tenantId, tenantId),
          isNotNull(techniques.frontier),
          or(isNull(techniques.legitimacy), and(gte(techniques.firstSeenAt, since), stale(techniques.legitimacy))),
        ),
      )
      .orderBy(desc(techniques.firstSeenAt))
  ).filter((t) => wanted(t) && !gaveUpSince(`technique.legitimacy:${t.id}`, judgedAt(t.legitimacy)));
  for (const t of [...techs.filter((t) => !t.legitimacy), ...techs.filter((t) => t.legitimacy)]) {
    if (queued >= limit) return queued;
    await review(t.id);
  }

  for (const r of await recsIn("gated_out")) {
    if (queued >= limit) return queued;
    const settled = current(r.tech.legitimacy) || r.tech.firstSeenAt < since;
    if (!r.tech.legitimacy?.passed || !settled || !wanted(r.tech) || gaveUpSince(`recommendation.soundness:${r.id}`, judgedAt(r.gate2))) continue;
    try {
      // What "Check again" does: back to candidate, then through Gate 2.
      await applyEvent(ctx.db, r.id, "regate");
    } catch (err) {
      if (err instanceof LifecycleError) continue;
      throw err;
    }
    await check(r.id);
  }
  return queued;
}

export { ECOSYSTEMS, ECOSYSTEM_LABEL, type Ecosystem } from "@elevate/sources";
