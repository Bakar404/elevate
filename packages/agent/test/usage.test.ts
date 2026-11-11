import { describe, expect, it } from "vitest";
import { estimateCostUsd, UsageRecorder } from "../src/usage";

describe("UsageRecorder", () => {
  it("aggregates by role and model, returns defensive snapshots, and resets", () => {
    const recorder = new UsageRecorder();
    recorder.record({ role: "gate1", model: "small", inputTokens: 10, outputTokens: 2 });
    recorder.record({ role: "gate1", model: "small", inputTokens: 5, outputTokens: 3 });
    recorder.record({ role: "gate2", model: "small", inputTokens: 1, outputTokens: 0 });
    recorder.record({ role: "gate1", model: "large", inputTokens: 7, outputTokens: 9 });
    const snapshot = recorder.snapshot();
    expect(snapshot).toEqual([
      { role: "gate1", model: "small", inputTokens: 15, outputTokens: 5 },
      { role: "gate2", model: "small", inputTokens: 1, outputTokens: 0 },
      { role: "gate1", model: "large", inputTokens: 7, outputTokens: 9 },
    ]);
    snapshot[0]!.inputTokens = 999;
    expect(recorder.snapshot()[0]!.inputTokens).toBe(15);
    recorder.reset();
    expect(recorder.snapshot()).toEqual([]);
    expect(snapshot).toHaveLength(3);
  });

  it("keeps unavailable or partial aggregate usage unknown rather than zero", () => {
    const recorder = new UsageRecorder();
    recorder.record({ role: "gate1", model: "small" });
    recorder.record({ role: "gate1", model: "small", inputTokens: 10, outputTokens: 2 });
    recorder.record({ role: "matcher", model: "large", inputTokens: 10 });
    recorder.record({ role: "matcher", model: "large", inputTokens: 5, outputTokens: 2 });
    expect(recorder.snapshot()).toEqual([
      { role: "gate1", model: "small", inputTokens: null, outputTokens: null },
      { role: "matcher", model: "large", inputTokens: 15, outputTokens: null },
    ]);
  });
});

describe("estimateCostUsd", () => {
  const env = { ELEVATE_MODEL_PRICES_JSON: JSON.stringify({ custom: { inputPerMTok: 2, outputPerMTok: 6 }, free: { inputPerMTok: 0, outputPerMTok: 0 } }) };

  it("uses configured exact model prices per million tokens, including genuine zeros", () => {
    expect(estimateCostUsd("custom", { inputTokens: 1_000_000, outputTokens: 500_000 }, env)).toBe(5);
    expect(estimateCostUsd("free", { inputTokens: 1, outputTokens: 2 }, env)).toBe(0);
    expect(estimateCostUsd("custom", { inputTokens: 0, outputTokens: 0 }, env)).toBe(0);
  });

  it("returns null for unavailable usage, unknown models, and invalid pricing", () => {
    expect(estimateCostUsd("custom", { inputTokens: null, outputTokens: 1 }, env)).toBeNull();
    expect(estimateCostUsd("custom", { inputTokens: 1 }, env)).toBeNull();
    expect(estimateCostUsd("unknown", { inputTokens: 1, outputTokens: 1 }, env)).toBeNull();
    for (const json of ["bad", "null", "[]", '{"custom":{"input":2,"output":6}}', '{"custom":{"inputPerMTok":2}}', '{"custom":{"inputPerMTok":-1,"outputPerMTok":2}}', '{"custom":{"inputPerMTok":"2","outputPerMTok":2}}']) {
      expect(estimateCostUsd("custom", { inputTokens: 1, outputTokens: 1 }, { ELEVATE_MODEL_PRICES_JSON: json })).toBeNull();
    }
    expect(estimateCostUsd("custom", { inputTokens: -1, outputTokens: 1 }, env)).toBeNull();
    expect(estimateCostUsd("custom", { inputTokens: Infinity, outputTokens: 1 }, env)).toBeNull();
  });
});
