import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, MODEL_ROLES, resolveAllModels, resolveModel } from "../src/models";

describe("model resolution", () => {
  it("preserves the runtime default without inventing a model id", () => {
    expect(DEFAULT_MODEL).toBe("");
  });

  it("uses trimmed role overrides, then the global model, then the existing default", () => {
    for (const role of MODEL_ROLES) {
      expect(resolveModel(role, {})).toBe(DEFAULT_MODEL);
      expect(resolveModel(role, { ELEVATE_MODEL: " global " })).toBe("global");
      expect(resolveModel(role, { ELEVATE_MODEL: "global", [`ELEVATE_MODEL_${role.toUpperCase()}`]: " specific " })).toBe("specific");
      expect(resolveModel(role, { ELEVATE_MODEL: "global", [`ELEVATE_MODEL_${role.toUpperCase()}`]: " \t " })).toBe("global");
      expect(resolveModel(role, { ELEVATE_MODEL: " \t " })).toBe(DEFAULT_MODEL);
    }
  });

  it("resolves all four roles independently without changing the environment", () => {
    const env = { ELEVATE_MODEL: "global", ELEVATE_MODEL_GATE1: " cheap ", OPENAI_EMBEDDING_MODEL: "embedding" };
    expect(resolveAllModels(env)).toEqual({ gate1: "cheap", gate2: "global", matcher: "global", swarm: "global" });
    expect(env.ELEVATE_MODEL_GATE1).toBe(" cheap ");
  });
});
