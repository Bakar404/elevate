/**
 * Gate eval: how well do the two gates separate real techniques from hype, and sound changes
 * from unsound ones? The kernel proves what the gates do with their inputs; this measures the
 * inputs. Usage:
 *   pnpm eval:gates            reference reviews from fixtures/gate-eval.json (offline, deterministic)
 *   pnpm eval:gates --live     ask the configured model (Copilot or BYOK) for each legitimacy review
 * Exits 1 if any hype passes Gate 1, any unsound change passes Gate 2, or legit recall < 0.75.
 */
import { readFileSync } from "node:fs";
import { CopilotLLM, modelConfigFromEnv } from "../packages/agent/src/index.ts";
import { consistentReview, evidencePrior, type EvidenceSignals } from "../packages/engine/src/gates.ts";
import { LEGITIMACY_SYSTEM, LegitimacySchema } from "../packages/engine/src/prompts.ts";
import { DEFAULT_THRESHOLDS, legitimacyDecision, soundnessDecision, type Risk, type Thresholds } from "../packages/policy/src/index.ts";

type LegitCase = { id: string; label: "legit" | "hype"; name: string; summary: string; links: string[]; signals: EvidenceSignals; review: { legit: boolean; score: number } };
type SoundCase = { id: string; label: "sound" | "unsound"; repo: string; technique: string; review: { sound: boolean; measurable: boolean; score: number; risk: Risk } };

const fixture = JSON.parse(readFileSync(new URL("../fixtures/gate-eval.json", import.meta.url), "utf8")) as { legitimacy: LegitCase[]; soundness: SoundCase[] };
const live = process.argv.includes("--live");

async function reviewOf(c: LegitCase, prior: ReturnType<typeof evidencePrior>) {
  if (!live) return c.review;
  const llm = new CopilotLLM(modelConfigFromEnv());
  const r = await consistentReview(llm, {
    task: "legitimacy",
    system: LEGITIMACY_SYSTEM,
    schema: LegitimacySchema,
    prompt: [
      `Technique: ${c.name}`,
      `Summary: ${c.summary}`,
      `Evidence:`,
      ...c.links.map((u) => `- Cited evidence: ${u}`),
      `- Signals: ${JSON.stringify(c.signals)}`,
      `Independent evidence prior: ${prior.score}/100 (${JSON.stringify(prior.parts)})`,
    ].join("\n"),
  }, (r) => r.legit);
  if (r.retried) console.error(`  (re-asked: contradictory review for ${c.name})`);
  return { legit: r.legit, score: r.score };
}

const rows: { c: LegitCase; prior: number; review: { legit: boolean; score: number } }[] = [];
for (const c of fixture.legitimacy) {
  const prior = evidencePrior(c.signals);
  rows.push({ c, prior: prior.score, review: await reviewOf(c, prior) });
}

function scoreLegit(t: Thresholds) {
  let tp = 0, fp = 0, fn = 0;
  const out = rows.map(({ c, prior, review }) => {
    const d = legitimacyDecision({ prior, review: review.score, legit: review.legit }, t);
    if (d.passed && c.label === "legit") tp++;
    else if (d.passed) fp++;
    else if (c.label === "legit") fn++;
    return { c, prior, review, d };
  });
  return { out, tp, fp, fn, precision: tp + fp ? tp / (tp + fp) : 1, recall: tp + fn ? tp / (tp + fn) : 1 };
}

const t: Thresholds = { ...DEFAULT_THRESHOLDS };
const g1 = scoreLegit(t);
console.log(`\nGate 1 · Legitimacy (${live ? "live model reviews" : "reference reviews"}; thresholds legitimacy ${t.legitimacy}, prior floor ${t.priorFloor})\n`);
for (const { c, prior, review, d } of g1.out) {
  const ok = d.passed === (c.label === "legit");
  console.log(`${ok ? "✓" : "✗"} ${c.label.padEnd(5)} ${d.passed ? "pass" : "fail"}  prior ${String(prior).padStart(3)}  review ${String(review.score).padStart(3)}${review.legit ? " " : "!"}  score ${String(d.score).padStart(3)}  ${d.reason.padEnd(15)} ${c.name}`);
}
console.log(`\nprecision ${g1.precision.toFixed(2)}  recall ${g1.recall.toFixed(2)}  hype passed ${g1.fp}`);

console.log("\nThreshold sweep (precision / recall / hype passed):");
const floors = [0, 10, 15, 20, 30, 40];
console.log(`legit\\floor ${floors.map((f) => String(f).padStart(14)).join("")}`);
for (const legitimacy of [50, 55, 60, 65, 70, 75]) {
  const cells = floors.map((priorFloor) => {
    const s = scoreLegit({ ...t, legitimacy, priorFloor });
    return `${s.precision.toFixed(2)}/${s.recall.toFixed(2)}/${s.fp}`.padStart(14);
  });
  console.log(`${String(legitimacy).padStart(11)} ${cells.join("")}`);
}

console.log(`\nGate 2 · Soundness (threshold ${t.soundness}, risk margins low +0 / medium +5 / high +15)\n`);
let g2Wrong = 0;
for (const c of fixture.soundness) {
  const d = soundnessDecision({ gate1Passed: true, ...c.review }, t.soundness);
  const ok = d.passed === (c.label === "sound");
  if (!ok) g2Wrong++;
  console.log(`${ok ? "✓" : "✗"} ${c.label.padEnd(7)} ${d.passed ? "pass" : "fail"}  score ${String(c.review.score).padStart(3)}  bar ${String(d.bar).padStart(3)}  ${d.reason.padEnd(14)} ${c.technique} → ${c.repo}`);
}

const failures = [
  g1.fp > 0 && `${g1.fp} hype technique(s) passed Gate 1`,
  g1.recall < 0.75 && `Gate 1 recall ${g1.recall.toFixed(2)} < 0.75`,
  g2Wrong > 0 && `${g2Wrong} soundness case(s) misjudged`,
].filter(Boolean);
console.log(failures.length ? `\nFAIL: ${failures.join("; ")}` : "\nPASS");
process.exit(failures.length ? 1 : 0);
