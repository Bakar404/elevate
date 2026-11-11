/**
 * Gate eval: how well do the two gates separate real techniques from hype, and sound changes
 * from unsound ones? The kernel proves what the gates do with their inputs; this measures the
 * inputs. Usage:
 *   pnpm eval:gates            reference reviews from fixtures/gate-eval.json (offline, deterministic)
 *   pnpm eval:gates --live     ask the configured model (Copilot or BYOK) for both gates
 *   pnpm eval:gates --live --runs 3 --model gpt-5.4 --out reports/gates-gpt54.json
 * Exits 1 if any hype passes Gate 1, any unsound change passes Gate 2, or legit recall < 0.75.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { CopilotLLM, defaultUsageRecorder, estimateCostUsd, modelConfigFromEnv, resolveAllModels, stopCopilotClient, type LLM } from "../packages/agent/src/index.ts";
import { consistentReview, evidencePrior, type EvidenceSignals } from "../packages/engine/src/gates.ts";
import { LEGITIMACY_SYSTEM, LegitimacySchema, SOUNDNESS_SYSTEM, SoundnessSchema } from "../packages/engine/src/prompts.ts";
import { DEFAULT_THRESHOLDS, legitimacyDecision, soundnessDecision, type Risk, type Thresholds } from "../packages/policy/src/index.ts";
import { aggregate, countContradictions, metrics, parseArgs, reviewMeasurable } from "./lib/eval-stats.ts";

type LegitCase = { id: string; label: "legit" | "hype"; name: string; summary: string; links: string[]; signals: EvidenceSignals; review: { legit: boolean; score: number } };
type SoundCase = { id: string; label: "sound" | "unsound"; repo: string; technique: string; review: { sound: boolean; measurable: boolean; score: number; risk: Risk } };

const fixtureBytes = readFileSync(new URL("../fixtures/gate-eval.json", import.meta.url));
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as { legitimacy: LegitCase[]; soundness: SoundCase[] };
const options = parseArgs(process.argv.slice(2));
const live = options.live;
const models = { ...resolveAllModels(), ...options.models };
const raw: Record<"gate1" | "gate2", { verdict: boolean; score: number }[]> = { gate1: [], gate2: [] };
const client = new CopilotLLM(modelConfigFromEnv());
const llm: LLM = {
  name: client.name,
  async json(req) {
    const result = await client.json(req);
    const review = result as { legit?: boolean; sound?: boolean; score: number };
    const role = req.role === "gate2" ? "gate2" : "gate1";
    raw[role].push({ verdict: (role === "gate1" ? review.legit : review.sound)!, score: review.score });
    return result;
  },
};

async function reviewOf(c: LegitCase, prior: ReturnType<typeof evidencePrior>) {
  if (!live) {
    raw.gate1.push({ verdict: c.review.legit, score: c.review.score });
    return c.review;
  }
  const r = await consistentReview(llm, {
    task: "legitimacy",
    role: "gate1",
    model: options.models.gate1,
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

async function runEvaluation() {
defaultUsageRecorder.reset();
raw.gate1 = [];
raw.gate2 = [];
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
const soundRows: { expected: boolean; passed: boolean }[] = [];
for (const c of fixture.soundness) {
  const review = live ? await consistentReview(llm, {
    task: "soundness",
    role: "gate2",
    model: options.models.gate2,
    system: SOUNDNESS_SYSTEM,
    schema: SoundnessSchema,
    // Fixture labels and reference reviews are deliberately withheld from the model.
    prompt: `Repository: ${c.repo}\nProposed change: ${c.technique}\nJudge only the information supplied; do not assume unavailable repository context.`,
  }, (r) => r.sound) : c.review;
  if (!live) raw.gate2.push({ verdict: review.sound, score: review.score });
  const d = soundnessDecision({ gate1Passed: true, ...review, measurable: reviewMeasurable(review) }, t.soundness);
  const ok = d.passed === (c.label === "sound");
  soundRows.push({ expected: c.label === "sound", passed: d.passed });
  if (!ok) g2Wrong++;
  console.log(`${ok ? "✓" : "✗"} ${c.label.padEnd(7)} ${d.passed ? "pass" : "fail"}  score ${String(review.score).padStart(3)}  bar ${String(d.bar).padStart(3)}  ${d.reason.padEnd(14)} ${c.technique} → ${c.repo}`);
}

const failures = [
  g1.fp > 0 && `${g1.fp} hype technique(s) passed Gate 1`,
  g1.recall < 0.75 && `Gate 1 recall ${g1.recall.toFixed(2)} < 0.75`,
  g2Wrong > 0 && `${g2Wrong} soundness case(s) misjudged`,
].filter(Boolean);
console.log(failures.length ? `\nFAIL: ${failures.join("; ")}` : "\nPASS");
const usage = defaultUsageRecorder.snapshot();
const costs = usage.map((u) => u.model ? estimateCostUsd(u.model, u) : null);
const tokens = (key: "inputTokens" | "outputTokens") =>
  usage.length && usage.every((u) => u[key] !== null) ? usage.reduce((sum, u) => sum + (u[key] ?? 0), 0) : null;
return {
  gate1: metrics(g1.out.map(({ c, d }) => ({ expected: c.label === "legit", passed: d.passed })), countContradictions(raw.gate1)),
  gate2: metrics(soundRows, countContradictions(raw.gate2)),
  usage,
  inputTokens: tokens("inputTokens"),
  outputTokens: tokens("outputTokens"),
  costUsd: costs.length && costs.every((c) => c !== null) ? costs.reduce<number>((sum, c) => sum + (c ?? 0), 0) : null,
  failures,
};
}

try {
  const runs: Awaited<ReturnType<typeof runEvaluation>>[] = [];
  for (let i = 0; i < options.runs; i++) runs.push(await runEvaluation());
  const aggregates = aggregate(runs);
  const total = (key: "inputTokens" | "outputTokens" | "costUsd") =>
    runs.every((r) => r[key] !== null) ? runs.reduce((sum, r) => sum + (r[key] ?? 0), 0) : null;
  const totals = { inputTokens: total("inputTokens"), outputTokens: total("outputTokens"), costUsd: total("costUsd") };
  if (options.runs > 1 || options.out || Object.keys(options.models).length) {
    console.log("\nGate | Model | Runs | Precision mean ± sd | Recall mean ± sd | Contradictions mean ± sd");
    const fmt = (s: { mean: number; sd: number }) => `${s.mean.toFixed(3)} ± ${s.sd.toFixed(3)}`;
    for (const role of ["gate1", "gate2"] as const) {
      const s = aggregates[role];
      console.log(`${role} | ${models[role] || "runtime default"} | ${options.runs} | ${fmt(s.precision)} | ${fmt(s.recall)} | ${fmt(s.contradictions)}`);
    }
    console.log(`Tokens in/out: ${totals.inputTokens ?? "unknown"}/${totals.outputTokens ?? "unknown"}; cost USD: ${totals.costUsd ?? "unknown"}`);
  }
  if (options.out) {
    const report = {
      mode: live ? "live" : "reference",
      models, runs, aggregates, totals,
      gitSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: new URL("..", import.meta.url), encoding: "utf8" }).trim(),
      fixturesHash: createHash("sha256").update(fixtureBytes).digest("hex"),
      timestamp: new Date().toISOString(),
    };
    mkdirSync(dirname(options.out), { recursive: true });
    writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
  }
  process.exitCode = runs.some((r) => r.failures.length) ? 1 : 0;
} finally {
  if (live) await stopCopilotClient();
}
