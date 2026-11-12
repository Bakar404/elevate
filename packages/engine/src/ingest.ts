import { cosine } from "@elevate/agent";
import { and, desc, emit, enqueue, eq, inArray, items, repos, sources, sql, techniques, type ItemSignals } from "@elevate/db";
import {
  buildFocusQueries,
  compareVersions,
  defaultFetch,
  defaultSources,
  fetchFocused,
  fetchSource,
  focusBackend,
  parseFocusResponse,
  refreshSourceUrl,
  type FocusBackend,
  type Fetcher,
  ECOSYSTEM_LABEL,
  findModels,
  isEcosystem,
  sourceEcosystem,
  type RawItem,
} from "@elevate/sources";
import { accessProfile, resetAccessCache, verdictFor } from "./access";
import type { Ctx } from "./context";
import { TRIAGE_SYSTEM, TriageSchema } from "./prompts";

export async function seedSources(ctx: Ctx, tenantId = "local") {
  // Demo workspaces are offline: keep their seeded sources only.
  if (ctx.demo) {
    const existing = await ctx.db.select({ id: sources.id }).from(sources).where(eq(sources.tenantId, tenantId)).limit(1);
    if (existing.length) return 0;
  }
  // Insert any default the workspace doesn't have yet (by URL), so new built-in sources reach existing users.
  const added = await ctx.db
    .insert(sources)
    .values(defaultSources().map((d) => ({ ...d, tenantId, config: d.config ?? {} })))
    .onConflictDoNothing()
    .returning({ id: sources.id });
  return added.length;
}

export async function sweepSources(ctx: Ctx, tenantId = "local") {
  const rows = await ctx.db
    .select()
    .from(sources)
    .where(and(eq(sources.tenantId, tenantId), eq(sources.enabled, true)));
  // A feed that is only about a product the user doesn't have is not fetched at all.
  const have = new Set((await accessProfile(ctx)).ecosystems);
  const due = rows.filter((s) => {
    const eco = sourceEcosystem(s);
    return !eco || have.has(eco);
  });
  for (const s of due) await enqueue(ctx.db, "source.fetch", { sourceId: s.id }, { dedupeKey: `source.fetch:${s.id}` });
  return due.length;
}

export async function fetchSourceItems(ctx: Ctx, sourceId: string) {
  const [src] = await ctx.db.select().from(sources).where(eq(sources.id, sourceId));
  if (!src) throw new Error(`Source ${sourceId} not found`);
  try {
    const backend = focusBackend(src.url);
    const raw = backend ? await fetchFocusedItems(ctx, src.tenantId, backend) : await fetchSource({ ...src, url: refreshSourceUrl(src) }, ctx.fetcher);
    let inserted = 0;
    let refocused = 0;
    let stale = 0;
    const cutoff = Date.now() - MAX_AGE_DAYS * DAY;
    for (const r of raw) {
      // Feeds return their whole archive: last year's launch post is not news.
      if (r.publishedAt && r.publishedAt.getTime() < cutoff) {
        stale++;
        continue;
      }
      const res = await ctx.db
        .insert(items)
        .values({
          tenantId: src.tenantId,
          sourceId: src.id,
          externalId: r.externalId ?? null,
          url: r.url,
          title: r.title.slice(0, 500),
          author: r.author ?? null,
          publishedAt: r.publishedAt ?? null,
          content: r.content ?? null,
          signals: r.signals ?? {},
        })
        .onConflictDoNothing()
        .returning({ id: items.id });
      inserted += res.length;
      if (!res.length && r.signals?.focus && (await attachFocus(ctx, src.tenantId, r))) refocused++;
    }
    await ctx.db.update(sources).set({ lastFetchedAt: new Date(), lastError: null }).where(eq(sources.id, src.id));
    if (inserted || refocused) {
      await emit(ctx.db, {
        kind: "source.fetched",
        message: `${src.name}: ${inserted} new items${refocused ? `, ${refocused} seen before now tied to your repos` : ""}${stale ? ` (${stale} older than ${MAX_AGE_DAYS} days skipped)` : ""}`,
        data: { sourceId: src.id },
      });
      await enqueue(ctx.db, "items.triage", {}, { dedupeKey: `items.triage:${src.tenantId}`, tenantId: src.tenantId });
    }
    return inserted;
  } catch (err) {
    await ctx.db
      .update(sources)
      .set({ lastFetchedAt: new Date(), lastError: err instanceof Error ? err.message : String(err) })
      .where(eq(sources.id, src.id));
    throw err;
  }
}

const DAY = 24 * 3600 * 1000;
/** Items published longer ago than this are not ingested or triaged. */
export const MAX_AGE_DAYS = Number(process.env.ELEVATE_MAX_ITEM_AGE_DAYS ?? 60);

const FOCUS_QUERIES = Number(process.env.ELEVATE_FOCUS_QUERIES ?? 8);

/** The searches a sweep runs on behalf of the watched repos. */
export async function focusQueries(ctx: Ctx, tenantId = "local", max = FOCUS_QUERIES) {
  const rows = await ctx.db
    .select({ id: repos.id, fullName: repos.fullName, language: repos.language, topics: repos.topics, pushedAt: repos.pushedAt, profile: repos.profile, archived: repos.archived })
    .from(repos)
    .where(and(eq(repos.tenantId, tenantId), eq(repos.watch, true)));
  return buildFocusQueries(rows.filter((r) => !r.archived), max);
}

/** GitHub search allows 10 anonymous requests a minute; with the user's token it's 30. */
async function gitHubFetcher(ctx: Ctx): Promise<Fetcher> {
  const token = await ctx.token().catch(() => undefined);
  if (!token) return defaultFetch;
  return (url) =>
    fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "elevate/0.1 (+https://github.com/Bakar404/elevate)" },
      signal: AbortSignal.timeout(20_000),
    });
}

async function fetchFocusedItems(ctx: Ctx, tenantId: string, backend: FocusBackend): Promise<RawItem[]> {
  const queries = await focusQueries(ctx, tenantId);
  if (!queries.length) return [];
  const fetcher = ctx.fetcher ?? (backend === "github" ? await gitHubFetcher(ctx) : defaultFetch);
  // arXiv asks API clients to wait 3 s between calls.
  const pauseMs = backend === "arxiv" && !ctx.fetcher ? 3000 : 0;
  const { items: found, errors } = await fetchFocused(backend, queries, fetcher, parseFocusResponse, { pauseMs });
  if (errors.length) {
    await emit(ctx.db, { kind: "source.partial", level: "warn", message: `${backend}: ${errors.length} of ${queries.length} searches failed (${errors[0]})`, tenantId });
  }
  return found;
}

/**
 * An item we already had (e.g. from the front page) also turned up in a repo search: remember which repos,
 * and triage it again with them in mind if it was dismissed without that context. Returns whether it changed.
 */
async function attachFocus(ctx: Ctx, tenantId: string, r: RawItem) {
  const [row] = await ctx.db
    .select({ id: items.id, signals: items.signals, status: items.status })
    .from(items)
    .where(and(eq(items.tenantId, tenantId), eq(items.url, r.url)));
  if (!row) return false;
  const prev = row.signals.focus?.repoIds ?? [];
  const next = [...new Set([...prev, ...r.signals!.focus!.repoIds])];
  if (next.length === prev.length) return false;
  const signals: ItemSignals = { ...row.signals, focus: { query: row.signals.focus?.query ?? r.signals!.focus!.query, repoIds: next } };
  await ctx.db
    .update(items)
    .set({ signals, ...(row.status === "irrelevant" ? { status: "new" as const } : {}) })
    .where(eq(items.id, row.id));
  return true;
}
/** The highest version on each model line, e.g. ["GPT-6.1", "Claude Opus 5.5"]. */
function newestPerLine(models: { family: string; version: number[]; label: string }[]): string[] {
  const best = new Map<string, { version: number[]; label: string }>();
  for (const m of models) {
    const b = best.get(m.family);
    if (!b || compareVersions(m.version, b.version) > 0) best.set(m.family, m);
  }
  return [...best.values()].map((m) => m.label);
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

const CLUSTER_THRESHOLD = Number(process.env.ELEVATE_CLUSTER_THRESHOLD ?? 0.82);
const TRIAGE_BATCH = 15;

/** Classify new items, extract techniques and cluster them into de-duplicated technique records. */
/**
 * `currentKey` is the dedupe key of the job running this: a follow-up enqueued under the same key
 * would be dropped while this job is still running, so the chain alternates between two keys.
 */
export async function triageItems(ctx: Ctx, tenantId = "local", maxItems = 45, currentKey?: string | null) {
  const pending = await ctx.db
    .select({ item: items, credibility: sources.credibility, sourceName: sources.name, sourceUrl: sources.url, sourceConfig: sources.config })
    .from(items)
    .innerJoin(sources, eq(items.sourceId, sources.id))
    .where(and(eq(items.tenantId, tenantId), eq(items.status, "new")))
    // Newest first, so a backlog never delays today's news.
    .orderBy(sql`${items.publishedAt} desc nulls last`, desc(items.createdAt))
    .limit(maxItems);
  if (!pending.length) return { processed: 0, techniques: 0 };

  // A backlog from before the age limit existed: dismiss without spending a model call.
  const cutoff = Date.now() - MAX_AGE_DAYS * DAY;
  const tooOld = pending.filter((p) => p.item.publishedAt && p.item.publishedAt.getTime() < cutoff);
  if (tooOld.length) {
    await ctx.db.update(items).set({ status: "irrelevant" }).where(inArray(items.id, tooOld.map((p) => p.item.id)));
  }
  const fresh = pending.filter((p) => !tooOld.includes(p));
  const access = await accessProfile(ctx);
  const header = [
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    `The user has: ${access.ecosystems.map((e) => ECOSYSTEM_LABEL[e]).join(", ") || "no AI products connected"}.`,
    access.available.length ? `Models on their plan right now: ${access.available.map((m) => m.label).join(", ")}.` : "",
    access.known.length ? `Newest model versions seen so far: ${newestPerLine(access.known).join(", ")}. Anything older on the same line is superseded.` : "",
  ]
    .filter(Boolean)
    .join("\n");
  const held: string[] = [];

  const known = await ctx.db
    .select({ id: techniques.id, slug: techniques.slug, embedding: techniques.embedding })
    .from(techniques)
    .where(eq(techniques.tenantId, tenantId));
  const created: string[] = [];
  const focusIds = [...new Set(pending.flatMap((p) => p.item.signals.focus?.repoIds ?? []))];
  const repoNames = new Map(
    focusIds.length
      ? (await ctx.db.select({ id: repos.id, fullName: repos.fullName, profile: repos.profile }).from(repos).where(inArray(repos.id, focusIds))).map((r) => [
          r.id,
          `${r.fullName}${r.profile ? ` (${r.profile.stack.slice(0, 5).join(", ")})` : ""}`,
        ])
      : [],
  );
  const foundFor = (s: ItemSignals) =>
    s.focus ? `\nFound searching "${s.focus.query}" for: ${s.focus.repoIds.map((id) => repoNames.get(id)).filter(Boolean).slice(0, 4).join("; ")}` : "";

  for (let i = 0; i < fresh.length; i += TRIAGE_BATCH) {
    const batch = fresh.slice(i, i + TRIAGE_BATCH);
    const prompt =
      `${header}\n\n` +
      batch
        .map(
          ({ item, sourceName }, idx) =>
            `[${idx}] (${sourceName}) ${item.title}\nURL: ${item.url}${item.publishedAt ? `\nPublished: ${item.publishedAt.toISOString().slice(0, 10)}` : ""}${foundFor(item.signals)}\n${(item.content ?? "").slice(0, 600)}`,
        )
        .join("\n\n");
    let result;
    try {
      result = await ctx.llm.json({ task: "triage", system: TRIAGE_SYSTEM, prompt, schema: TriageSchema });
    } catch (err) {
      await ctx.db
        .update(items)
        .set({ status: "error" })
        .where(inArray(items.id, batch.map((b) => b.item.id)));
      await emit(ctx.db, { kind: "triage.error", level: "error", message: `Triage failed: ${String(err).slice(0, 200)}` });
      continue;
    }
    const byIndex = new Map(result.results.map((r) => [r.index, r]));

    for (let idx = 0; idx < batch.length; idx++) {
      const { item, sourceUrl, sourceConfig } = batch[idx]!;
      const r = byIndex.get(idx);
      if (!r?.relevant || !r.technique) {
        await ctx.db.update(items).set({ status: "irrelevant" }).where(eq(items.id, item.id));
        continue;
      }
      const t = r.technique;
      const text = `${t.name}\n${t.summary}\n${t.appliesTo.join(", ")}\n${t.claimedBenefits.join(", ")}`;
      const [embedding] = await ctx.embedder.embed([text]);
      const slug = slugify(t.name);

      let best: { id: string; sim: number } | undefined;
      for (const k of known) {
        const sim = k.slug === slug ? 1 : k.embedding ? cosine(embedding!, k.embedding) : 0;
        if (!best || sim > best.sim) best = { id: k.id, sim };
      }

      let techniqueId: string;
      if (best && best.sim >= CLUSTER_THRESHOLD) {
        techniqueId = best.id;
        // Extra corroboration can flip a previously failed legitimacy verdict.
        if (!created.includes(best.id)) {
          await enqueue(ctx.db, "technique.legitimacy", { techniqueId }, { dedupeKey: `technique.legitimacy:${techniqueId}` });
        }
      } else {
        const novelty = best ? Math.max(0, Math.min(1, 1 - best.sim)) : 1;
        const [row] = await ctx.db
          .insert(techniques)
          .values({
            tenantId,
            name: t.name,
            slug,
            summary: t.summary,
            category: t.category,
            claims: {
              claimedBenefits: t.claimedBenefits,
              appliesTo: t.appliesTo,
              prerequisites: t.prerequisites,
              evidenceLinks: t.evidenceLinks,
              // News from a product's own feed is about that product unless triage said otherwise.
              requires: t.requires.length ? t.requires.filter(isEcosystem) : [sourceEcosystem({ url: sourceUrl, config: sourceConfig })].filter(isEcosystem),
              // The model's list plus any version written in the name itself.
              models: [...new Set([...t.models, ...findModels(t.name).map((m) => m.label)])],
            },
            embedding,
            novelty,
          })
          .onConflictDoNothing()
          .returning({ id: techniques.id });
        if (!row) {
          const [existing] = await ctx.db
            .select({ id: techniques.id })
            .from(techniques)
            .where(and(eq(techniques.tenantId, tenantId), eq(techniques.slug, slug)));
          techniqueId = existing!.id;
        } else {
          techniqueId = row.id;
          created.push(row.id);
          known.push({ id: row.id, slug, embedding: embedding! });
        }
      }
      await ctx.db
        .update(items)
        .set({ status: "triaged", techniqueId, embedding })
        .where(eq(items.id, item.id));
    }
  }

  // New titles may have raised what counts as the newest model version.
  resetAccessCache(ctx);
  const now = await accessProfile(ctx);
  for (const id of created) {
    const [t] = await ctx.db.select().from(techniques).where(eq(techniques.id, id));
    const verdict = t ? verdictFor(t, now) : { usable: true as const };
    // Nothing the user can act on is worth a legitimacy review; it is kept on the Radar with the reason.
    if (!verdict.usable) {
      held.push(`${t!.name} (${verdict.reason})`);
      continue;
    }
    await enqueue(ctx.db, "technique.legitimacy", { techniqueId: id }, { dedupeKey: `technique.legitimacy:${id}` });
  }
  if (held.length) {
    await emit(ctx.db, { kind: "techniques.held", message: `Set aside ${held.length} that ${held.length === 1 ? "doesn't" : "don't"} fit your setup: ${held.slice(0, 3).join("; ")}${held.length > 3 ? "…" : ""}` });
  }
  if (created.length) {
    await emit(ctx.db, {
      kind: "techniques.discovered",
      message: `Discovered ${created.length} new technique${created.length === 1 ? "" : "s"}`,
      level: "success",
    });
  }
  if (pending.length === maxItems) {
    const more = `items.triage:${tenantId}:more`;
    await enqueue(ctx.db, "items.triage", {}, { dedupeKey: currentKey === more ? `${more}:next` : more, tenantId });
  }
  return { processed: pending.length, techniques: created.length };
}
