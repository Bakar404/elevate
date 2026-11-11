import { describe, expect, it } from "vitest";
import { sortModels, toModelOption } from "../src";

// Shapes as returned by the Copilot runtime's models.list.
const sonnet = { id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5", provider: { name: "anthropic" } };
const luna = { id: "gpt-6-luna", name: "GPT-6 Luna", provider: "openai" };
const auto = { id: "auto", name: "Auto" };

describe("toModelOption", () => {
  it("keeps id, name and vendor, and falls back to the id for a missing name", () => {
    expect(toModelOption(sonnet)).toEqual({ id: "claude-sonnet-5.5", name: "Claude Sonnet 5.5", vendor: "anthropic", enabled: true });
    expect(toModelOption(luna).vendor).toBe("openai");
    expect(toModelOption({ id: "x" }).name).toBe("x");
  });

  it("marks policy-disabled models", () => {
    expect(toModelOption({ ...sonnet, policy: { state: "disabled" } }).enabled).toBe(false);
    expect(toModelOption({ ...sonnet, policy: { state: "enabled" } }).enabled).toBe(true);
  });
});

describe("sortModels", () => {
  it("puts auto first and disabled models last, otherwise keeping the runtime's order", () => {
    const off = { ...toModelOption(luna), id: "off", name: "Off", enabled: false };
    const order = sortModels([toModelOption(sonnet), off, toModelOption(luna), toModelOption(auto)]).map((m) => m.id);
    expect(order).toEqual(["auto", "claude-sonnet-5.5", "gpt-6-luna", "off"]);
  });
});
