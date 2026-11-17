import { emit, enqueue, eq, getSetting, items, recommendations, repos, sources, techniques, type GateResult } from "@elevate/db";
import { readRepoFile, searchPublicRepos } from "@elevate/github";
import {
  DEFAULT_THRESHOLDS,
  legitimacyDecision,
  pct,
  recommendationScore,
  soundnessDecision,
  type Risk,
  type Thresholds,
} from "@elevate/policy";
import { hackerNewsSignal } from "@elevate/sources";
import type { JsonRequest, LLM } from "@elevate/agent";
import type { Ctx } from "./context";
import { applyEvent } from "./lifecycle";
import { LEGITIMACY_SYSTEM, LegitimacySchema, SOUNDNESS_SYSTEM, SoundnessSchema } from "./prompts";

export async function thresholds(ctx: Ctx): Promise<Thresholds> {
  return { ...DEFAULT_THRESHOLDS, ...(await getSetting<Partial<Thresholds>>(ctx.db, "gates.thresholds", {})) };
}

/** A verdict and a 0-100 score that disagree (e.g. legit=true, score=0) is a model slip, not a judgment. */
export function contradicts(verdict: boolean, score: number): boolean {
  return verdict ? score < 50 : score >= 50;
}

/**
 * Ask for a gate review; if the answer contradicts itself, ask once more. A second contradiction caps the
 * score below 50 (under every gate threshold), so a glitch can only hide a recommendation, never let one through.
 */
export async function consistentReview<T extends { score: number }>(
  llm: LLM,
  req: JsonRequest<T>,
  verdict: (r: T) => boolean,
): Promise<T & { retried: boolean }> {
  const first = await llm.json(req);
  if (!contradicts(verdict(first), first.score)) return { ...first, retried: false };
  const second = await llm.json(req);
  if (!contradicts(verdict(second), second.score)) return { ...second, retried: true };
  return { ...second, score: Math.min(first.score, second.score, 49), retried: true };
}

export type EvidenceSignals = {
  maxCredibility: number;
  distinctSources: number;
  hnPoints: number;
  hnStories: number;
  topRepoStars: number;
  evidenceLinks: number;
  /** Days since the technique was first published. Absent: treated as old enough that missing discussion and code count fully. */
  ageDays?: number;
};

/** Discussion and public code take weeks to appear. Until a technique is this old, their absence counts against it only in part. */
export const YOUNG_DAYS = 30;

/**
 * Bumped whenever what the gates are shown or asked changes enough to change verdicts. Recent verdicts from an
 * older calibration get one more review (see `reviewDue`).
 */
export const GATE_CALIBRATION = 2;

/**
 * The evidence prior: what the world says, independent of the LLM. Its
 * quality is checked by the gate eval set, not proved; the kernel only
 * promises what is done with it (L1–L6).
 *
 * Something published this week can't have discussion or code yet, so for a young technique those two parts
 * are judged by what the other signals say (never by more), fading out over YOUNG_DAYS. Every signal can
 * still only raise the prior, and a weak source stays under the floor however new it is.
 */
export function evidencePrior(e: EvidenceSignals) {
  const credibility = pct(e.maxCredibility);
  const corroboration = (Math.min(Math.max(e.distinctSources, 0), 4) / 4) * 100;
  const community = pct((Math.log10(1 + Math.max(e.hnPoints, 0)) / 3) * 80 + Math.min(Math.max(e.hnStories, 0), 10) * 2);
  const code = pct((Math.log10(1 + Math.max(e.topRepoStars, 0)) / 4) * 100);
  const evidence = Math.min(Math.max(e.evidenceLinks, 0), 3) * 33.4;
  const youth = e.ageDays === undefined ? 0 : Math.max(0, 1 - Math.max(e.ageDays, 0) / YOUNG_DAYS);
  const stand = ((credibility * 0.35 + corroboration * 0.2 + evidence * 0.1) / 0.65) * youth;
  const weigh = (community: number, code: number) =>
    pct(credibility * 0.35 + corroboration * 0.2 + community * 0.2 + code * 0.15 + evidence * 0.1);
  const score = weigh(Math.max(community, stand), Math.max(code, stand));
  const newness = score - weigh(community, code);
  return { score, parts: { credibility, corroboration: Math.round(corroboration), community, code, evidence: pct(evidence), ...(newness > 0 ? { newness } : {}) } };
}

/** The line that tells the reviewer how new a technique is, and what that means for the evidence it can have. */
export function ageNote(ageDays: number) {
  const d = Math.floor(Math.max(ageDays, 0));
  const when = d < 1 ? "today" : d === 1 ? "1 day ago" : `${d} days ago`;
  return ageDays < YOUNG_DAYS
    ? `First published ${when}. Discussion and public code usually take weeks to appear, so their absence says little yet.`
    : `First published ${when}.`;
}

const EXCERPTS = 4;
/** Room for a whole arXiv abstract (up to ~1,900 characters), whose reported results come last. */
const EXCERPT_CHARS = 2000;
const plain = (s: string) =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, "")}…` : s);

const RISK_ORDER: Risk[] = ["low", "medium", "high"];
const higherRisk = (a: Risk, b: Risk): Risk => (RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b);

async function readRepoFileSafe(ctx: Ctx, fullName: string, path: string) {
  try {
    return await readRepoFile(await ctx.github(), fullName, path);
  } catch {
    return null;
  }
}

/** Gate 1: is the new thing actually legit? */
export async function legitimacyGate(ctx: Ctx, techniqueId: string): Promise<GateResult> {
  const [tech] = await ctx.db.select().from(techniques).where(eq(techniques.id, techniqueId));
  if (!tech) throw new Error(`Technique ${techniqueId} not found`);

  const linked = await ctx.db
    .select({
      title: items.title,
      url: items.url,
      content: items.content,
      signals: items.signals,
      publishedAt: items.publishedAt,
      createdAt: items.createdAt,
      source: sources.name,
      credibility: sources.credibility,
    })
    .from(items)
    .innerJoin(sources, eq(items.sourceId, sources.id))
    .where(eq(items.techniqueId, techniqueId));

  const [hn, gh] = await Promise.all([
    hackerNewsSignal(tech.name, ctx.fetcher).catch(() => ({ stories: 0, points: 0, comments: 0, top: [] as { title: string; points: number; url: string }[] })),
    ctx
      .github()
      .then((o) => searchPublicRepos(o, tech.name))
      .catch(() => ({ total: 0, top: [] as { fullName: string; stars: number; url: string }[] })),
  ]);

  const directPoints = linked.reduce((s, l) => s + (Number(l.signals?.points) || 0), 0);
  const published = (l: (typeof linked)[number]) => l.publishedAt ?? l.createdAt;
  // A feed date in the future is a feed bug; first seen here bounds it.
  const firstPublished = Math.min(tech.firstSeenAt.getTime(), ...linked.map((l) => published(l).getTime()));
  const ageDays = Math.max(0, (Date.now() - firstPublished) / 86_400_000);
  const prior = evidencePrior({
    maxCredibility: Math.max(0, ...linked.map((l) => l.credibility)),
    distinctSources: new Set(linked.map((l) => l.source)).size,
    hnPoints: Math.max(hn.points, directPoints),
    hnStories: hn.stories,
    topRepoStars: Math.max(gh.top[0]?.stars ?? 0, ...linked.map((l) => Number(l.signals?.stars) || 0)),
    evidenceLinks: tech.claims.evidenceLinks.length,
    ageDays,
  });
  // What the sources actually say (an abstract, a release note), most credible first: a title alone can't show a method or results.
  const excerpts = linked
    .map((l) => ({ ...l, text: l.content ? plain(l.content) : "" }))
    .filter((l) => l.text.length >= 40)
    .sort((a, b) => b.credibility - a.credibility)
    .slice(0, EXCERPTS)
    .map((l) => `### ${l.title} (${l.source}, ${published(l).toISOString().slice(0, 10)})\n${clip(l.text, EXCERPT_CHARS)}`);

  const evidence: GateResult["evidence"] = [
    ...linked.map((l) => ({ label: `Reported by ${l.source} (credibility ${l.credibility})`, detail: l.title, url: l.url })),
    { label: "Hacker News discussion", detail: `${hn.stories} stories, ${hn.points} points, ${hn.comments} comments` },
    ...hn.top.slice(0, 3).map((t) => ({ label: "HN thread", detail: `${t.title} (${t.points} pts)`, url: t.url })),
    { label: "Public code", detail: `${gh.total} GitHub repos match` },
    ...gh.top.slice(0, 3).map((r) => ({ label: "Repo", detail: `${r.fullName} ★${r.stars}`, url: r.url })),
    ...tech.claims.evidenceLinks.slice(0, 5).map((u) => ({ label: "Cited evidence", detail: u, url: u })),
  ];

  const review = await consistentReview(ctx.llm, {
    task: "legitimacy",
    system: LEGITIMACY_SYSTEM,
    schema: LegitimacySchema,
    prompt: [
      `Technique: ${tech.name} (${tech.category})`,
      `Summary: ${tech.summary}`,
      `Claimed benefits: ${tech.claims.claimedBenefits.join("; ") || "none stated"}`,
      ageNote(ageDays),
      ...(excerpts.length ? [`Source excerpts:`, ...excerpts] : [`Source excerpts: none (titles only)`]),
      `Evidence:`,
      ...evidence.map((e) => `- ${e.label}: ${e.detail}${e.url ? ` <${e.url}>` : ""}`),
      `Independent evidence prior: ${prior.score}/100 (${JSON.stringify(prior.parts)})`,
    ].join("\n"),
  }, (r) => r.legit);

  const t = await thresholds(ctx);
  const d = legitimacyDecision({ prior: prior.score, review: review.score, legit: review.legit }, t);
  const why = {
    passed: "passed",
    vetoed: "the reviewer judged it not legitimate",
    no_evidence: `independent evidence ${prior.score} is below the floor of ${t.priorFloor}`,
    below_threshold: `score ${d.score} is below ${t.legitimacy}`,
  }[d.reason];
  const result: GateResult = {
    passed: d.passed,
    score: d.score,
    verdict: d.passed ? review.verdict : `Not passed: ${why}. ${review.verdict}`,
    reasons: [...review.reasons, ...review.redFlags.map((r) => `Red flag: ${r}`)],
    evidence: [
      {
        label: "Independent evidence prior",
        detail: `${prior.score}/100${prior.parts.newness ? ` (new: +${prior.parts.newness} while discussion and code have had no time to appear)` : ""}`,
        weight: 0.4,
      },
      { label: "Reviewer score", detail: `${pct(review.score)}/100 (${review.legit ? "legit" : "not legit"})`, weight: 0.6 },
      ...evidence,
    ],
    checkedAt: new Date().toISOString(),
    calibration: GATE_CALIBRATION,
  };

  await ctx.db.update(techniques).set({ legitimacy: result, legitimacyScore: d.score, updatedAt: new Date() }).where(eq(techniques.id, techniqueId));
  await emit(ctx.db, {
    kind: "gate.legitimacy",
    level: d.passed ? "success" : "info",
    message: `${tech.name}: legitimacy ${d.score}/100, ${d.passed ? "passed" : why}`,
    data: { techniqueId },
  });
  if (d.passed) await enqueue(ctx.db, "technique.match", { techniqueId }, { dedupeKey: `technique.match:${techniqueId}` });
  return result;
}

/** Gate 2: is the improvement sound for this repo, and will it make a measurable difference? */
export async function soundnessGate(ctx: Ctx, recommendationId: string): Promise<GateResult> {
  const [row] = await ctx.db
    .select({ rec: recommendations, repo: repos, tech: techniques })
    .from(recommendations)
    .innerJoin(repos, eq(recommendations.repoId, repos.id))
    .innerJoin(techniques, eq(recommendations.techniqueId, techniques.id))
    .where(eq(recommendations.id, recommendationId));
  if (!row) throw new Error(`Recommendation ${recommendationId} not found`);
  const { rec, repo, tech } = row;
  if (rec.status !== "candidate") return rec.gate2 ?? { passed: false, score: 0, verdict: "Not a candidate", reasons: [], evidence: [], checkedAt: new Date().toISOString() };
  // The repo was turned off: leave it a candidate (no model call). Turning the repo back on re-queues this check.
  if (!repo.watch) return { passed: false, score: 0, verdict: "Skipped: the repo is turned off", reasons: [], evidence: [], checkedAt: new Date().toISOString() };

  const files = (
    await Promise.all(rec.hypothesis.touchpoints.slice(0, 4).map(async (p) => ({ path: p, content: await readRepoFileSafe(ctx, repo.fullName, p) })))
  ).filter((f): f is { path: string; content: string } => !!f.content);

  const review = await consistentReview(ctx.llm, {
    task: "soundness",
    system: SOUNDNESS_SYSTEM,
    schema: SoundnessSchema,
    prompt: [
      `Repository: ${repo.fullName}`,
      `Profile:\n${repo.profileText ?? "(no profile)"}`,
      `Technique: ${tech.name}: ${tech.summary}`,
      `Technique legitimacy: ${tech.legitimacyScore ?? "?"}/100`,
      `Proposed change: ${rec.hypothesis.change}`,
      `Rationale: ${rec.hypothesis.rationale}`,
      `Claimed impact: ${rec.hypothesis.expectedImpact}`,
      `Effort/risk (matcher's guess): ${rec.hypothesis.effort}/${rec.hypothesis.risk}`,
      ...files.map((f) => `--- ${f.path} ---\n${f.content.slice(0, 6000)}`),
    ].join("\n\n"),
  }, (r) => r.sound);

  const t = await thresholds(ctx);
  const risk = higherRisk(rec.hypothesis.risk, review.risk);
  const measurable = review.measurable && review.measurement.trim().length > 0;
  const d = soundnessDecision(
    { gate1Passed: tech.legitimacy?.passed === true, sound: review.sound, measurable, score: review.score, risk },
    t.soundness,
  );
  const why = {
    passed: "passed",
    gate1_failed: "the technique has not passed the legitimacy gate",
    vetoed: "the reviewer judged it unsound",
    not_measurable: "there is no concrete way to measure the impact",
    below_bar: `score ${pct(review.score)} is below the ${risk}-risk bar of ${d.bar}`,
  }[d.reason];
  const result: GateResult = {
    passed: d.passed,
    score: pct(review.score),
    verdict: d.passed ? review.verdict : `Not passed: ${why}. ${review.verdict}`,
    reasons: [...review.reasons, ...review.risks.map((r) => `Risk: ${r}`)],
    evidence: [
      { label: "Expected impact", detail: review.expectedImpact },
      { label: "How to measure", detail: review.measurement || "(none given)" },
      { label: "Risk", detail: `${risk} (bar ${d.bar})` },
      { label: "Effort", detail: review.effort },
      ...files.map((f) => ({ label: "Inspected file", detail: f.path })),
    ],
    checkedAt: new Date().toISOString(),
    calibration: GATE_CALIBRATION,
  };

  const score = recommendationScore(rec.relevance * 100, tech.legitimacyScore ?? 0, result.score);
  await applyEvent(ctx.db, rec.id, d.passed ? "gate_pass" : "gate_fail", { gate1: tech.legitimacy, gate2: result, score });
  await emit(ctx.db, {
    kind: "gate.soundness",
    level: d.passed ? "success" : "info",
    message: d.passed ? `New recommendation for ${repo.fullName}: ${rec.title}` : `${rec.title} (${repo.fullName}) filtered: ${why}`,
    data: { recommendationId: rec.id, repoId: repo.id },
  });
  return result;
}
