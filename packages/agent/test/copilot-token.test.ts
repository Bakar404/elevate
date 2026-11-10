import { describe, expect, it } from "vitest";
import { resolveCopilotToken } from "../src/copilot";

const gh = (tokens: Record<string, string>) => async (user?: string) => {
  const t = tokens[user ?? "(active)"];
  if (!t) throw new Error("no gh login");
  return `${t}\n`;
};

describe("resolveCopilotToken", () => {
  it("prefers COPILOT_GITHUB_TOKEN, then GITHUB_TOKEN", async () => {
    expect(await resolveCopilotToken({ COPILOT_GITHUB_TOKEN: "c", GITHUB_TOKEN: "g" }, gh({}))).toBe("c");
    expect(await resolveCopilotToken({ GITHUB_TOKEN: "g" }, gh({ "(active)": "a" }))).toBe("g");
  });

  it("uses the gh token for GITHUB_USER instead of the Copilot CLI login", async () => {
    const tokens = { Bakar404: "personal", "(active)": "other" };
    expect(await resolveCopilotToken({ GITHUB_USER: "Bakar404" }, gh(tokens))).toBe("personal");
    expect(await resolveCopilotToken({}, gh(tokens))).toBe("other");
  });

  it("returns undefined when gh has no token", async () => {
    expect(await resolveCopilotToken({ GITHUB_USER: "nobody" }, gh({}))).toBeUndefined();
  });
});
