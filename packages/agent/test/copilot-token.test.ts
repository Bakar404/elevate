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

  it("uses the account pinned in Settings, unless GITHUB_USER names another", async () => {
    const tokens = { Bakar404: "personal", work: "work", "(active)": "other" };
    expect(await resolveCopilotToken({}, gh(tokens), "Bakar404")).toBe("personal");
    expect(await resolveCopilotToken({ GITHUB_USER: "work" }, gh(tokens), "Bakar404")).toBe("work");
  });

  it("refuses to bill another account when the chosen one has no gh login", async () => {
    await expect(resolveCopilotToken({ GITHUB_USER: "nobody" }, gh({ "(active)": "other" }))).rejects.toThrow(/nobody/);
    await expect(resolveCopilotToken({}, gh({ "(active)": "other" }), "nobody")).rejects.toThrow(/nobody/);
  });

  it("returns undefined when no account was chosen and gh has no token", async () => {
    expect(await resolveCopilotToken({}, gh({}))).toBeUndefined();
  });
});
