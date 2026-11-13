import { desc, enqueue, eq, getSetting, gte, items, sources, recommendations, setSetting, techniques } from "@elevate/db";
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


export { ECOSYSTEMS, ECOSYSTEM_LABEL, type Ecosystem } from "@elevate/sources";
