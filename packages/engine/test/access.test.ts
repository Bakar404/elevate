import { HashingEmbedder } from "@elevate/agent";
import { createDb, sources } from "@elevate/db";
import { FakeGitHub } from "@elevate/executors";
import { detectEcosystems, findModels, inferTags, judgeAccess, parseFeed, sourceEcosystem, defaultSources, type Access } from "@elevate/sources";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  accessProfile,
  addSource,
  demoLLM,
  detectAccess,
  discoveryFeed,
  drain,
  fetchSourceItems,
  listRecommendations,
  listSources,
  radar,
  recheckAccess,
  removeSource,
  seedDemo,
  setAccessOverrides,
  sweepSources,
  type Ctx,
} from "../src";

const models = (ids: string) => findModels(ids);
const access = (ecosystems: Access["ecosystems"], available = "", known = ""): Access => ({ ecosystems, available: models(available), known: models(known) });

describe("model and ecosystem detection", () => {
  it("reads model ids and prose", () => {
    expect(findModels("gpt-6.1-sol").map((m) => m.label)).toEqual(["GPT-6.1 Sol"]);
    expect(findModels("Claude Opus 4.7 and claude-sonnet-5.5").map((m) => [m.family, m.version.join(".")])).toEqual([
      ["claude-opus", "4.7"],
      ["claude-sonnet", "5.5"],
    ]);
    expect(findModels("Claude 3.5 Sonnet")[0]).toMatchObject({ family: "claude-sonnet", version: [3, 5] });
    expect(findModels("claude-opus-4-7")[0]).toMatchObject({ family: "claude-opus", version: [4, 7] });
    expect(findModels("claude-sonnet-4-20250514")[0]).toMatchObject({ family: "claude-sonnet", version: [4] });
    expect(findModels("Gemini 3.1 Pro")[0]).toMatchObject({ family: "gemini", version: [3, 1], variant: "pro" });
    expect(findModels("Property-based testing")).toEqual([]);
  });

  it("names the most specific ecosystem", () => {
    expect(detectEcosystems("Codex cloud tasks")).toEqual(["codex"]);
    expect(detectEcosystems("Skills in Claude Code")).toEqual(["claude-code"]);
    expect(detectEcosystems("GPT-6.1 for agents")).toEqual(["openai"]);
    expect(detectEcosystems("Speculative decoding")).toEqual([]);
  });

  it("ties a technique to a vendor only when it is about one vendor", () => {
    expect(inferTags("Codex cloud tasks").requires).toEqual(["codex"]);
    expect(inferTags("Benchmarking GPT-6 against Claude Opus 5.5").requires).toEqual([]);
    expect(inferTags("Property-based testing", "Evaluated with GPT-6.1").requires).toEqual(["openai"]);
    expect(inferTags("Property-based testing", "Works with GPT, Claude and Gemini").requires).toEqual([]);
  });
});

describe("judgeAccess", () => {
  it("hides news about a replaced model version", () => {
    const v = judgeAccess(inferTags("GPT-5.4 prompt caching"), access(["openai"], "", "gpt-6.1-sol"));
    expect(v).toMatchObject({ usable: false, kind: "superseded" });
    expect(v.usable ? "" : v.reason).toMatch(/GPT-5\.4 has been superseded by GPT-6\.1/);
  });

  it("keeps an older version the plan still offers, and a migration that names the new one", () => {
    expect(judgeAccess(inferTags("GPT-6 Astra long context"), access(["openai"], "gpt-6-astra gpt-6.1-sol")).usable).toBe(true);
    expect(judgeAccess(inferTags("Migrating from GPT-5.4 to GPT-6.1"), access(["openai"], "", "gpt-6.1-sol")).usable).toBe(true);
  });

  it("compares Claude tiers on their own line, and an untiered mention against all of them", () => {
    const a = access(["anthropic"], "", "claude-opus-5.5 claude-haiku-4.5");
    expect(judgeAccess(inferTags("Claude Haiku 4.5 batch mode"), a).usable).toBe(true);
    expect(judgeAccess(inferTags("Claude Opus 4.7 extended thinking"), a).usable).toBe(false);
    expect(judgeAccess(inferTags("Claude 4 tool use"), a).usable).toBe(false);
  });

  it("a Claude-only user gets no Codex or GPT news, and the reverse", () => {
    const claude = access(["anthropic", "claude-code"]);
    expect(judgeAccess(inferTags("Codex cloud tasks"), claude)).toMatchObject({ usable: false, kind: "no-access" });
    expect(judgeAccess(inferTags("GPT-6.1 structured outputs"), claude)).toMatchObject({ usable: false, kind: "no-access" });
    expect(judgeAccess(inferTags("Claude Code subagents"), claude).usable).toBe(true);
    expect(judgeAccess(inferTags("Speculative decoding"), claude).usable).toBe(true);
    expect(judgeAccess(inferTags("Claude Code subagents"), access(["openai", "codex"])).usable).toBe(false);
  });

  it("a Copilot user isn't shown models their plan doesn't list", () => {
    const copilot = access(["copilot", "openai", "anthropic"], "gpt-6.1-sol claude-sonnet-5.5");
    expect(judgeAccess(inferTags("Claude Opus 5.5 extended thinking"), copilot)).toMatchObject({ usable: false, kind: "not-on-plan" });
    expect(judgeAccess(inferTags("Claude Sonnet 5.5 extended thinking"), copilot).usable).toBe(true);
    // No list to check against (bring-your-own-key): not judged.
    expect(judgeAccess(inferTags("Claude Opus 5.5 extended thinking"), access(["anthropic"])).usable).toBe(true);
  });
});

describe("detectAccess", () => {
  const opt = (id: string, vendor: string, enabled = true) => ({ id, name: id, vendor, enabled });
  it("follows the provider and, for Copilot, the vendors on the plan", () => {
    expect(detectAccess("anthropic", [])).toEqual(["anthropic", "claude-code"]);
    expect(detectAccess("openai", [])).toEqual(["openai", "codex"]);
    expect(detectAccess("azure", [])).toEqual(["openai"]);
    expect(detectAccess("copilot", [opt("gpt-6.1-sol", "openai"), opt("claude-opus-5.5", "anthropic", false)])).toEqual(["copilot", "openai"]);
  });
  it("adds the product behind an explicitly chosen executor", () => {
    expect(detectAccess("anthropic", [], "codex-cloud")).toEqual(["openai", "codex", "anthropic", "claude-code"]);
    expect(detectAccess("copilot", [opt("gpt-6.1-sol", "openai")], "local", "claude")).toContain("claude-code");
  });
});

describe("in the pipeline", () => {
  const handle = createDb({ memory: true });
  let ctx: Ctx;
  beforeAll(async () => {
    await handle.ready;
    ctx = {
      db: handle.db,
      demo: true,
      llm: demoLLM(),
      embedder: new HashingEmbedder(),
      github: () => Promise.reject(new Error("offline")),
      writer: async () => new FakeGitHub(),
      token: async () => "t",
      fetcher: async () => {
        throw new Error("offline");
      },
    };
    await seedDemo(ctx);
    await drain(ctx);
  }, 120_000);
  afterAll(() => handle.close());

  const tech = async (re: RegExp) => (await radar(ctx)).find((t) => re.test(t.name))!;

  it("sets aside what the demo workspace can't use, with the reason, before any gate runs", async () => {
    expect((await accessProfile(ctx)).ecosystems).toEqual(["copilot", "openai", "anthropic"]);
    expect(await tech(/GPT-5\.4/)).toMatchObject({ legitimacy: null, access: { usable: false, kind: "superseded" } });
    expect(await tech(/Codex/)).toMatchObject({ legitimacy: null, access: { usable: false, kind: "no-access" } });
    expect(await tech(/Gemini/)).toMatchObject({ legitimacy: null, access: { usable: false } });
    expect((await tech(/Speculative/)).access.usable).toBe(true);
    const recs = await listRecommendations(ctx);
    expect(recs.some((r) => /GPT-5\.4|Codex|Gemini/.test(r.technique))).toBe(false);
    expect((await discoveryFeed(ctx, { hideHype: true })).some((i) => /GPT-5\.4|Codex|Gemini/.test(i.title))).toBe(false);
    expect((await discoveryFeed(ctx)).find((i) => /Codex/.test(i.title))?.blocked).toMatch(/Needs Codex/);
  });

  it("checks a held technique once the user says they have the product", async () => {
    await setAccessOverrides(ctx, { codex: true });
    expect(await recheckAccess(ctx)).toBeGreaterThan(0);
    await drain(ctx);
    const codex = await tech(/Codex/);
    expect(codex.access.usable).toBe(true);
    expect(codex.legitimacy).not.toBeNull();
    await setAccessOverrides(ctx, { codex: null });
    expect((await tech(/Codex/)).access.usable).toBe(false);
  });

  it("skips archive posts and feeds for products the user doesn't have", async () => {
    const old = new Date(Date.now() - 400 * 24 * 3600 * 1000).toUTCString();
    const now = new Date().toUTCString();
    const feed = `<rss><channel>
      <item><title>Introducing GPT-5.4</title><link>https://example.com/old</link><pubDate>${old}</pubDate></item>
      <item><title>Fuzzing parsers with coverage feedback</title><link>https://example.com/new</link><pubDate>${now}</pubDate></item>
    </channel></rss>`;
    expect(parseFeed(feed)).toHaveLength(2);
    const src = await addSource(ctx, { name: "Test feed", url: "https://example.com/feed.xml" });
    const live: Ctx = { ...ctx, fetcher: async () => ({ ok: true, status: 200, text: async () => feed }) };
    expect(await fetchSourceItems(live, src.id)).toBe(1);

    const codexFeed = defaultSources().find((d) => d.name === "Codex releases")!;
    expect(sourceEcosystem(codexFeed)).toBe("codex");
    expect(sourceEcosystem({ url: "https://openai.com/news/rss.xml", config: {} })).toBe("openai");
    await ctx.db.insert(sources).values({ ...codexFeed, config: codexFeed.config ?? {} });
    const listed = await listSources(ctx);
    expect(listed.find((s) => s.name === "Codex releases")?.paused).toMatch(/Codex/);
    const enabled = listed.filter((s) => s.enabled).length;
    expect(await sweepSources(ctx)).toBe(enabled - 1);

    await expect(removeSource(ctx, listed.find((s) => s.name === "Codex releases")!.id)).rejects.toThrow(/Built-in/);
    expect(await removeSource(ctx, src.id)).toEqual({ removed: true });
  });
});
