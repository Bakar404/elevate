import { contradicts } from "../../packages/engine/src/gates.ts";

export type EvalOptions = {
  live: boolean;
  runs: number;
  models: Partial<Record<"gate1" | "gate2", string>>;
  out?: string;
};

export function parseArgs(args: string[]): EvalOptions {
  const options: EvalOptions = { live: false, runs: 1, models: {} };
  let model: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--live") { options.live = true; continue; }
    if (!["--runs", "--model", "--model-gate1", "--model-gate2", "--out"].includes(flag!)) {
      throw new Error(`Unknown argument: ${flag}`);
    }
    const value = args[++i]?.trim();
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (flag === "--runs") {
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error("--runs must be a positive integer");
      options.runs = Number(value);
    } else if (flag === "--model") model = value;
    else if (flag === "--model-gate1") options.models.gate1 = value;
    else if (flag === "--model-gate2") options.models.gate2 = value;
    else options.out = value;
  }
  options.models = { ...(model ? { gate1: model, gate2: model } : {}), ...options.models };
  return options;
}

export function summarize(values: number[]) {
  if (!values.length) throw new Error("At least one measurement is required");
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = values.length === 1 ? 0 : Math.sqrt(values.reduce((sum, n) => sum + (n - mean) ** 2, 0) / (values.length - 1));
  return { mean, sd, min: Math.min(...values), max: Math.max(...values) };
}

export type GateMetrics = { precision: number; recall: number; contradictions: number };
export type EvalRun = { gate1: GateMetrics; gate2: GateMetrics };

export function metrics(rows: { expected: boolean; passed: boolean }[], contradictions: number): GateMetrics {
  const tp = rows.filter((r) => r.expected && r.passed).length;
  const fp = rows.filter((r) => !r.expected && r.passed).length;
  const fn = rows.filter((r) => r.expected && !r.passed).length;
  return { precision: tp + fp ? tp / (tp + fp) : 1, recall: tp + fn ? tp / (tp + fn) : 1, contradictions };
}

// Use the engine's existing verdict/score contradiction rule, including raw attempts before retries.
export function countContradictions(reviews: { verdict: boolean; score: number }[]): number {
  return reviews.filter((r) => contradicts(r.verdict, r.score)).length;
}

export function reviewMeasurable(review: { measurable: boolean; measurement?: string }): boolean {
  return review.measurable && (review.measurement === undefined || review.measurement.trim().length > 0);
}

export function aggregate(runs: EvalRun[]) {
  const gate = (key: keyof EvalRun) => ({
    precision: summarize(runs.map((r) => r[key].precision)),
    recall: summarize(runs.map((r) => r[key].recall)),
    contradictions: summarize(runs.map((r) => r[key].contradictions)),
  });
  return { gate1: gate("gate1"), gate2: gate("gate2") };
}
