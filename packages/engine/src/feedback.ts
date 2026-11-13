import {
  and,
  audit,
  emit,
  eq,
  getSetting,
  gt,
  inArray,
  isNotNull,
  items,
  or,
  recommendations,
  repos,
  setSetting,
  sources,
  techniques,
  type GateResult,
  type Hypothesis,
  type RecommendationStatus,
  type TechniqueClaims,
} from "@elevate/db";
import { accessProfile, verdictFor } from "./access";
import type { Ctx } from "./context";
import { cuttingEdgeOnly, isCuttingEdge, ROUTINE_REASON } from "./frontier";
import { explain, featurize, fit, leanings, likeChance, optimisticChance, passesOn, predict, type Example, type LearnerInput, type Model } from "./learner";
import { LifecycleError } from "./lifecycle";

/**
 * Likes and dislikes on recommendations, and what elevate does with them: they train the model in
 * learner.ts, which ranks what's ready for review and holds back ideas you consistently pass on.
 */

export type Vote = "like" | "dislike" | "none";

const VOTE_VALUE: Record<Vote, 1 | -1 | null> = { like: 1, dislike: -1, none: null };

/** Record the user's vote. It never changes a recommendation's status; it changes what they're shown. */
export async function setFeedback(ctx: Ctx, id: string, vote: Vote, actor = "user") {
  const feedback = VOTE_VALUE[vote];
  const [row] = await ctx.db
    .update(recommendations)
    .set({ feedback, feedbackAt: new Date() })
    .where(eq(recommendations.id, id))
    .returning({ title: recommendations.title, tenantId: recommendations.tenantId });
  if (!row) throw new LifecycleError(`Recommendation ${id} not found`);
  await audit(ctx.db, actor, "recommendation.feedback", id, { vote }, row.tenantId);
  await emit(ctx.db, {
    kind: "feedback.recorded",
    level: vote === "like" ? "success" : "info",
    message: vote === "like" ? `You liked "${row.title}"` : vote === "dislike" ? `You passed on "${row.title}"` : `Cleared your vote on "${row.title}"`,
    data: { recommendationId: id, vote },
    tenantId: row.tenantId,
  });
  return { id, feedback };
}

/** Statuses that mean the user went ahead with a recommendation. */
const WENT_AHEAD: RecommendationStatus[] = ["approved", "in_progress", "pr_opened", "failed", "merged"];
/** Approving or rejecting says less than a vote (a good idea can be rejected for a busy repo), so it counts half. */
const DECISION_WEIGHT = 0.5;
/** Approvals and rejections from before the last reset don't count. */
const SINCE_SETTING = "recs.learnerSince";
/** Refit at least this often, so features that change without a vote (new sources for a technique) are picked up. */
const REFIT_MS = 10 * 60_000;

function reward(r: { feedback: number | null; status: string }): Pick<Example, "y" | "weight"> | null {
  if (r.feedback === 1) return { y: 1, weight: 1 };
  if (r.feedback === -1) return { y: 0, weight: 1 };
  if (r.status === "rejected") return { y: 0, weight: DECISION_WEIGHT };
  if ((WENT_AHEAD as string[]).includes(r.status)) return { y: 1, weight: DECISION_WEIGHT };
  return null;
}

/** Everything the learner and the hold rules need to know about a recommendation. */
export const subjectColumns = {
  id: recommendations.id,
  status: recommendations.status,
  title: recommendations.title,
  score: recommendations.score,
  relevance: recommendations.relevance,
  hypothesis: recommendations.hypothesis,
  gate1: recommendations.gate1,
  gate2: recommendations.gate2,
  feedback: recommendations.feedback,
  repo: repos.fullName,
  techniqueId: techniques.id,
  technique: techniques.name,
  techniqueSummary: techniques.summary,
  category: techniques.category,
  claims: techniques.claims,
  frontier: techniques.frontier,
  embedding: techniques.embedding,
};

export type RecSubject = {
  id: string;
  status: string;
  title: string;
  score: number;
  relevance: number;
  hypothesis: Hypothesis;
  gate1: GateResult | null;
  gate2: GateResult | null;
  feedback: number | null;
  repo: string;
  techniqueId: string;
  technique: string;
  techniqueSummary: string;
  category: string;
  claims: TechniqueClaims;
  frontier: boolean | null;
  embedding: number[] | null;
};

/** Where each technique was found (hn, rss, arxiv, github). */
async function sourceKinds(ctx: Ctx, techniqueIds: string[]) {
  const out = new Map<string, string[]>();
  const ids = [...new Set(techniqueIds)];
  if (!ids.length) return out;
  const rows = await ctx.db
    .selectDistinct({ techniqueId: items.techniqueId, kind: sources.kind })
    .from(items)
    .innerJoin(sources, eq(items.sourceId, sources.id))
    .where(inArray(items.techniqueId, ids));
  for (const r of rows) if (r.techniqueId) out.set(r.techniqueId, [...(out.get(r.techniqueId) ?? []), r.kind]);
  return out;
}

function learnerInput(r: RecSubject, kinds: Map<string, string[]>): LearnerInput {
  return {
    title: r.title,
    repo: r.repo,
    technique: r.technique,
    summary: r.techniqueSummary,
    category: r.category,
    cuttingEdge: isCuttingEdge({ name: r.technique, summary: r.techniqueSummary, frontier: r.frontier }),
    sources: kinds.get(r.techniqueId) ?? [],
    effort: r.hypothesis?.effort ?? null,
    risk: r.hypothesis?.risk ?? null,
    gate1: r.gate1?.score ?? null,
    gate2: r.gate2?.score ?? null,
    relevance: r.relevance,
    embedding: r.embedding,
  };
}

type Learned = { model: Model; likes: number; dislikes: number; decisions: number };
type Cached = { signature: string; at: number; learned: Promise<Learned> };

// On globalThis so every route bundle that loads this module shares one model per database.
const CACHE = Symbol.for("elevate.learner");
const cache = () => ((globalThis as unknown as Record<symbol, WeakMap<object, Cached> | undefined>)[CACHE] ??= new WeakMap());

/**
 * The model trained on every vote and decision. Refit only when they change: the cheap query below
 * reads just what identifies the training set, and the fit itself runs once however many callers ask.
 */
async function learned(ctx: Ctx): Promise<Learned> {
  const since = await getSetting<string | null>(ctx.db, SINCE_SETTING, null);
  const decided = and(inArray(recommendations.status, [...WENT_AHEAD, "rejected"]), since ? gt(recommendations.decidedAt, new Date(since)) : undefined);
  const rows = await ctx.db
    .select({ id: recommendations.id, status: recommendations.status, feedback: recommendations.feedback, frontier: techniques.frontier, updatedAt: recommendations.updatedAt })
    .from(recommendations)
    .innerJoin(techniques, eq(recommendations.techniqueId, techniques.id))
    .where(or(isNotNull(recommendations.feedback), decided));
  const signature = `${since}|${rows
    .map((r) => `${r.id}:${r.status}:${r.feedback}:${r.frontier}:${r.updatedAt.getTime()}`)
    .sort()
    .join(",")}`;
  const store = cache();
  const hit = store.get(ctx.db);
  if (hit && hit.signature === signature && Date.now() - hit.at < REFIT_MS) return hit.learned;
  const promise = (async (): Promise<Learned> => {
    const subjects: RecSubject[] = rows.length
      ? await ctx.db
          .select(subjectColumns)
          .from(recommendations)
          .innerJoin(repos, eq(recommendations.repoId, repos.id))
          .innerJoin(techniques, eq(recommendations.techniqueId, techniques.id))
          .where(inArray(recommendations.id, rows.map((r) => r.id)))
      : [];
    const kinds = await sourceKinds(ctx, subjects.map((s) => s.techniqueId));
    const examples: Example[] = [];
    let decisions = 0;
    for (const s of subjects) {
      const r = reward(s);
      if (!r) continue;
      if (s.feedback == null) decisions++;
      examples.push({ x: featurize(learnerInput(s, kinds)), ...r });
    }
    return {
      model: fit(examples),
      likes: subjects.filter((s) => s.feedback === 1).length,
      dislikes: subjects.filter((s) => s.feedback === -1).length,
      decisions,
    };
  })();
  store.set(ctx.db, { signature, at: Date.now(), learned: promise });
  promise.catch(() => store.get(ctx.db)?.learned === promise && store.delete(ctx.db));
  return promise;
}

/** Why an open recommendation isn't waiting on the user. */
export type Held = { kind: "access" | "disliked" | "routine" | "learned"; reason: string };

export type Judgement = {
  /** Set on an open recommendation that is shown as filtered out instead of ready for review. */
  held: Held | null;
  /** Why the user can't act on the technique any more (replaced model, product not connected), whatever the status. */
  blocked: string | null;
  /** The model's estimate that the user would like it, once there is anything to learn from. */
  fit: number | null;
  /** What in their votes moved that estimate, in words. */
  why: { toward: string[]; away: string[] } | null;
  /** Where it ranks among open recommendations: Bayes-UCB's optimistic P(like), or the score before any votes. */
  rank: number;
};

const passReason = (away: string[] = []) => {
  const words = away.filter((w) => !w.startsWith("ideas like ones"));
  return words.length ? `You usually pass on ${words.join(" and ")}` : "You usually pass on ideas like this";
};

/**
 * Judge recommendations for display. An open one is held back (shown under Filtered out) when the
 * user can't act on it, disliked it, it is routine upkeep while only cutting-edge ideas are wanted,
 * or the model is confident they'd pass on it. A like overrides the last two.
 */
export async function judgeRecs(ctx: Ctx, recs: RecSubject[]): Promise<Map<string, Judgement>> {
  const out = new Map<string, Judgement>();
  if (!recs.length) return out;
  const [{ model }, access, onlyCuttingEdge, kinds] = await Promise.all([learned(ctx), accessProfile(ctx), cuttingEdgeOnly(ctx), sourceKinds(ctx, recs.map((r) => r.techniqueId))]);
  for (const r of recs) {
    const input = learnerInput(r, kinds);
    const x = featurize(input);
    const p = model.n ? predict(model, x) : null;
    const why = p ? explain(model, x) : null;
    const verdict = verdictFor({ name: r.technique, summary: r.techniqueSummary, claims: r.claims }, access);
    const blocked = verdict.usable ? null : verdict.reason;
    let held: Held | null = null;
    if (r.status === "open") {
      if (blocked) held = { kind: "access", reason: blocked };
      else if (r.feedback === -1) held = { kind: "disliked", reason: "You disliked this" };
      else if (r.feedback === 1) held = null;
      else if (onlyCuttingEdge && !input.cuttingEdge) held = { kind: "routine", reason: ROUTINE_REASON };
      else if (p && passesOn(model, p)) held = { kind: "learned", reason: passReason(why?.away) };
    }
    out.set(r.id, {
      held,
      blocked,
      fit: p ? likeChance(p) : null,
      why: why && (why.toward.length || why.away.length) ? why : null,
      rank: p ? optimisticChance(p, model.n) : r.score / 100,
    });
  }
  return out;
}

/** What the model has learned, for Settings. */
export async function learnerSummary(ctx: Ctx) {
  const { model, likes, dislikes, decisions } = await learned(ctx);
  return { likes, dislikes, decisions, ...(model.n ? leanings(model) : { toward: [], away: [] }), cuttingEdgeOnly: await cuttingEdgeOnly(ctx) };
}

/** Forget every vote and earlier approvals and rejections: ranking starts again from the prior. */
export async function resetLearner(ctx: Ctx, actor = "user") {
  const cleared = await ctx.db
    .update(recommendations)
    .set({ feedback: null, feedbackAt: new Date() })
    .where(isNotNull(recommendations.feedback))
    .returning({ id: recommendations.id });
  await setSetting(ctx.db, SINCE_SETTING, new Date().toISOString());
  await audit(ctx.db, actor, "learner.reset", "recommendations", { votes: cleared.length });
  await emit(ctx.db, {
    kind: "learner.reset",
    message: `Forgot ${cleared.length} vote${cleared.length === 1 ? "" : "s"} and earlier decisions: recommendations are ranked from scratch`,
  });
  return { cleared: cleared.length };
}
