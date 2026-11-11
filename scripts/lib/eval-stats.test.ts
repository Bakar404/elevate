import { describe, expect, it } from "vitest";
import { aggregate, countContradictions, metrics, parseArgs, reviewMeasurable, summarize } from "./eval-stats";

describe("gate evaluation options", () => {
  it("preserves defaults and applies role overrides independent of flag order", () => {
    expect(parseArgs([])).toEqual({ live: false, runs: 1, models: {} });
    expect(parseArgs(["--model-gate1", "one", "--model", "both", "--runs", "3", "--live", "--out", "/tmp/g.json"]))
      .toEqual({ live: true, runs: 3, models: { gate1: "one", gate2: "both" }, out: "/tmp/g.json" });
    expect(parseArgs(["--model-gate2", "two"]).models).toEqual({ gate2: "two" });
  });
  it.each([["--runs", "0"], ["--runs", "1.5"], ["--runs", "-1"], ["--runs", "Infinity"], ["--model"], ["--out", "--live"], ["--unknown"]])("rejects invalid arguments %j", (...args) => {
    expect(() => parseArgs(args)).toThrow();
  });
});

describe("gate statistics", () => {
  it("uses sample standard deviation and handles one run", () => {
    expect(summarize([1, 2, 3])).toEqual({ mean: 2, sd: 1, min: 1, max: 3 });
    expect(summarize([0.75])).toEqual({ mean: 0.75, sd: 0, min: 0.75, max: 0.75 });
    expect(() => summarize([])).toThrow();
    const gate = { precision: 1, recall: 0.75, contradictions: 2 };
    expect(aggregate([{ gate1: gate, gate2: gate }]).gate1.recall.sd).toBe(0);
  });
  it("counts contradictions exactly as the engine, not policy threshold failures", () => {
    expect(countContradictions([
      { verdict: true, score: 49 }, { verdict: false, score: 50 },
      { verdict: true, score: 50 }, { verdict: false, score: 49 },
    ])).toBe(2);
  });
  it("computes precision and recall with empty-denominator defaults", () => {
    expect(metrics([{ expected: true, passed: true }, { expected: true, passed: false }, { expected: false, passed: true }], 2))
      .toEqual({ precision: 0.5, recall: 0.5, contradictions: 2 });
    expect(metrics([], 0)).toEqual({ precision: 1, recall: 1, contradictions: 0 });
  });
  it("rejects empty live measurements while preserving reference reviews", () => {
    expect(reviewMeasurable({ measurable: true, measurement: "   " })).toBe(false);
    expect(reviewMeasurable({ measurable: false, measurement: "pnpm test" })).toBe(false);
    expect(reviewMeasurable({ measurable: true, measurement: "pnpm test" })).toBe(true);
    expect(reviewMeasurable({ measurable: true })).toBe(true);
  });
});
