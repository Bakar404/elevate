import { describe, expect, it } from "vitest";
import { sortModels, toModelOption } from "../src";

// Shapes as returned by the Copilot runtime's models.list (AI credits per billing batch).
const sonnet = {
  id: "claude-sonnet-5.5",
  name: "Claude Sonnet 5.5",
  billing: { tokenPrices: { inputPrice: 200, outputPrice: 1000, cachePrice: 10, cacheReadPrice: 10, batchSize: 1_000_000 } },
};
const luna = { id: "gpt-6-luna", name: "GPT-6 Luna", billing: { tokenPrices: { inputPrice: 10, outputPrice: 50, cacheReadPrice: 1, batchSize: 1_000_000 } } };
const codex = { id: "gpt-5.3-codex", name: "GPT-5.3-Codex", billing: { tokenPrices: { inputPrice: 175, outputPrice: 1400, cachePrice: 17.5, batchSize: 1_000_000 } } };
const auto = { id: "auto", name: "Auto", billing: { discountPercent: 10 } };

describe("toModelOption", () => {
  it("converts AI credits per batch to GitHub's USD per 1M tokens", () => {
    expect(toModelOption(sonnet).price).toEqual({ input: 2, output: 10, cachedInput: 0.1 });
    expect(toModelOption(luna).price).toEqual({ input: 0.1, output: 0.5, cachedInput: 0.01 });
    expect(toModelOption(codex).price).toEqual({ input: 1.75, output: 14, cachedInput: 0.175 });
  });

  it("scales by batch size, and leaves price unset rather than inventing one", () => {
    const small = toModelOption({ id: "x", billing: { tokenPrices: { inputPrice: 2, outputPrice: 10, batchSize: 10_000 } } });
    expect(small.price).toMatchObject({ input: 2, output: 10 });
    expect(toModelOption(auto)).toMatchObject({ price: undefined, discountPercent: 10, name: "Auto" });
    expect(toModelOption({ id: "legacy", billing: { multiplier: 0.33 } })).toMatchObject({ price: undefined, multiplier: 0.33 });
  });

  it("marks policy-disabled models", () => {
    expect(toModelOption({ ...sonnet, policy: { state: "disabled" } }).enabled).toBe(false);
    expect(toModelOption({ ...sonnet, policy: { state: "enabled" } }).enabled).toBe(true);
  });
});

describe("sortModels", () => {
  it("puts auto first, then cheaper output first, and disabled models last", () => {
    const off = { ...toModelOption(luna), id: "off", name: "Off", enabled: false };
    const order = sortModels([toModelOption(codex), off, toModelOption(sonnet), toModelOption(luna), toModelOption(auto)]).map((m) => m.id);
    expect(order).toEqual(["auto", "gpt-6-luna", "claude-sonnet-5.5", "gpt-5.3-codex", "off"]);
  });
});
