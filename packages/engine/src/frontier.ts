import { isContentFiltered } from "@elevate/agent";
import { and, desc, emit, enqueue, eq, getSetting, isNull, setSetting, techniques } from "@elevate/db";
import type { Ctx } from "./context";
import { CLASSIFY_SYSTEM, ClassifySchema } from "./prompts";

/**
 * elevate recommends what's new: AI/ML techniques, model capabilities, agent patterns, research.
 * Routine upkeep (a patch release, a deprecation, a database tip) stays on the Radar but never
 * becomes a recommendation while this setting is on (the default).
 */
export const CUTTING_EDGE_SETTING = "recs.cuttingEdgeOnly";

export const cuttingEdgeOnly = (ctx: Ctx) => getSetting<boolean>(ctx.db, CUTTING_EDGE_SETTING, true);

export const setCuttingEdgeOnly = (ctx: Ctx, on: boolean) => setSetting(ctx.db, CUTTING_EDGE_SETTING, on);

export const ROUTINE_REASON = "Routine upkeep, not cutting-edge";

/** Upkeep whatever the subject: releases that only patch, CVEs, deprecations, style guides. */
const UPKEEP = [
  /\b(minor|patch|point|maintenance|bug-?fix)\s+(releases?|updates?|versions?|upgrades?)\b/i,
  /\bsecurity\s+(releases?|patch(es)?|fix(es)?)\b/i,
  /\bCVE-\d{4}-\d{3,}|\bCVEs?\b/,
  /\bdeprecat(e|ed|es|ing|ion|ions)\b/i,
  /\bend[- ]of[- ](life|support)\b|\bEOL\b/i,
  /\bstyle ?guides?\b/i,
  /\bversion bumps?\b/i,
];

/** Chores that are only upkeep when they aren't about AI: databases, pinning, forced migrations. */
const CHORES = [
  /\b(postgres(ql)?|mysql|mariadb|sqlite|sql server|oracle database|sql|jsonb|autovacuum|vacuum)\b/i,
  /\b(lock(ing|ed)?|pin(ning|ned)?)\b.{0,30}\b(dependenc(y|ies)|actions|versions?|images?)\b/i,
  /\bmigrat(e|es|ing|ion)\b.{0,20}\b(off|away from)\b/i,
];

const AI =
  /\b(ai|llms?|gpts?|claude|gemini|copilot|codex|agents?|agentic|rag|embeddings?|vector (search|index|database)|pgvector|transformers?|diffusion|neural|machine learning|deep learning|ml|fine-?tun\w*|prompts?|prompting|mcp|model context protocol|multimodal|text-to-sql|nl2sql)\b/i;

/** A deterministic check for routine upkeep, used before the model has classified a technique and as a floor after. */
export function looksRoutine(t: { name: string; summary?: string | null }): boolean {
  const text = `${t.name}\n${t.summary ?? ""}`;
  if (UPKEEP.some((re) => re.test(text))) return true;
  return !AI.test(text) && CHORES.some((re) => re.test(text));
}

/** Cutting-edge unless the model or the upkeep patterns call it routine. */
export function isCuttingEdge(t: { name: string; summary?: string | null; frontier?: boolean | null }): boolean {
  return t.frontier !== false && !looksRoutine(t);
}

const CLASSIFY_BATCH = 20;
const CLASSIFY_MAX = 120;

/**
 * Classify techniques recorded before triage said whether they are cutting-edge (and any it left out).
 * Runs after every sweep; it does nothing once every technique has an answer.
 */
export async function classifyTechniques(ctx: Ctx, tenantId = "local", currentKey?: string | null) {
  const rows = await ctx.db
    .select({ id: techniques.id, name: techniques.name, summary: techniques.summary, category: techniques.category })
    .from(techniques)
    .where(and(eq(techniques.tenantId, tenantId), isNull(techniques.frontier)))
    .orderBy(desc(techniques.firstSeenAt))
    .limit(CLASSIFY_MAX);
  if (!rows.length) return 0;
  const set = (id: string, frontier: boolean) => ctx.db.update(techniques).set({ frontier }).where(eq(techniques.id, id));
  const batches: (typeof rows)[] = [];
  for (let i = 0; i < rows.length; i += CLASSIFY_BATCH) batches.push(rows.slice(i, i + CLASSIFY_BATCH));
  let routine = 0;
  let classified = 0;
  while (batches.length) {
    const batch = batches.shift()!;
    let result;
    try {
      result = await ctx.llm.json({
        task: "classify",
        system: CLASSIFY_SYSTEM,
        schema: ClassifySchema,
        prompt: batch.map((t, i) => `[${i}] ${t.name} (${t.category})\n${t.summary.slice(0, 400)}`).join("\n\n"),
      });
    } catch (err) {
      if (!isContentFiltered(err)) throw err;
      // Like triage: isolate the one the content filter won't discuss, and judge that one by the patterns.
      if (batch.length > 1) {
        const half = Math.ceil(batch.length / 2);
        batches.unshift(batch.slice(0, half), batch.slice(half));
      } else {
        const frontier = !looksRoutine(batch[0]!);
        await set(batch[0]!.id, frontier);
        classified++;
        if (!frontier) routine++;
      }
      continue;
    }
    for (const r of result.results) {
      const t = batch[r.index];
      if (!t) continue;
      await set(t.id, r.frontier);
      classified++;
      if (!isCuttingEdge({ ...t, frontier: r.frontier })) routine++;
    }
  }
  if (classified) {
    await emit(ctx.db, {
      kind: "techniques.classified",
      message: `Sorted ${classified} technique${classified === 1 ? "" : "s"}: ${routine} routine upkeep, ${classified - routine} cutting-edge`,
      tenantId,
    });
  }
  if (rows.length === CLASSIFY_MAX && classified) {
    // Same two-key alternation as triage: a follow-up under the running job's own key would be dropped.
    const more = `techniques.classify:${tenantId}:more`;
    await enqueue(ctx.db, "techniques.classify", {}, { dedupeKey: currentKey === more ? `${more}:next` : more, tenantId });
  }
  return classified;
}
