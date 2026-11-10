import { HashingEmbedder, type LLM } from "@elevate/agent";
import { createDb, eq, items, repos, sources, techniques } from "@elevate/db";
import { FakeGitHub } from "@elevate/executors";
import { buildFocusQueries, fetchFocused, focusUrl, normalizeTerm, parseFocusResponse, type FocusRepo, type Fetcher } from "@elevate/sources";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { demoLLM, drain, fetchSourceItems, focusQueries, matchTechnique, seedDemo, type Ctx } from "../src";

const repo = (id: string, profile: FocusRepo["profile"], extra: Partial<FocusRepo> = {}): FocusRepo => ({ id, fullName: `me/${id}`, profile, ...extra });

describe("buildFocusQueries", () => {
  const fleet = [
    repo("big", { stack: ["Next.js", "Drizzle", "pgvector", "Tailwind CSS", "Vitest"], domains: ["LLM agents", "code review", "retrieval"] }),
    repo("small", { stack: ["Rust", "embassy"], domains: ["embedded"] }),
    repo("twin", { stack: ["pgvector"], domains: ["retrieval"] }),
    repo("bare", null, { language: "TypeScript", topics: [] }),
  ];

  it("gives every repo with a searchable term at least one query before shared terms fill the rest", () => {
    const qs = buildFocusQueries(fleet, 3);
    expect(qs).toHaveLength(3);
    for (const id of ["big", "small", "twin"]) expect(qs.some((q) => q.repoIds.includes(id))).toBe(true);
  });

  it("never exceeds the budget and never repeats a term", () => {
    for (const max of [0, 1, 2, 5, 50]) {
      const qs = buildFocusQueries(fleet, max);
      expect(qs.length).toBeLessThanOrEqual(max);
      expect(new Set(qs.map((q) => q.term.toLowerCase())).size).toBe(qs.length);
    }
  });

  it("drops generic terms and versions; a shared term carries every repo and ranks first", () => {
    const qs = buildFocusQueries(fleet, 50);
    const terms = qs.map((q) => q.term.toLowerCase());
    expect(terms).not.toContain("typescript");
    expect(terms).not.toContain("vitest");
    expect(normalizeTerm("React 19 (app router)")).toBe("React");
    expect(normalizeTerm("a very long phrase that is not a search term")).toBeUndefined();
    const retrieval = qs.find((q) => q.term === "retrieval")!;
    expect(retrieval.repoIds.sort()).toEqual(["big", "twin"]);
    expect(qs[0]!.repoIds.length).toBe(2);
  });

  it("is deterministic", () => {
    expect(buildFocusQueries([...fleet].reverse(), 6).map((q) => q.term).sort()).toEqual(buildFocusQueries(fleet, 6).map((q) => q.term).sort());
  });
});

const ok = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const hn = (...hits: { id: string; title: string; url: string }[]) =>
  ok({ hits: hits.map((h) => ({ objectID: h.id, title: h.title, url: h.url, author: "x", points: 80, num_comments: 12, created_at: new Date().toISOString() })), nbHits: hits.length });

describe("fetchFocused", () => {
  const qs = [
    { term: "pgvector", kind: "stack" as const, repoIds: ["a"], score: 2 },
    { term: "retrieval", kind: "domain" as const, repoIds: ["b"], score: 2 },
    { term: "broken", kind: "domain" as const, repoIds: ["c"], score: 1 },
  ];

  it("merges an item found by several searches into one item that carries all their repos, and tolerates a failing search", async () => {
    const fetcher: Fetcher = async (url) =>
      url.includes("broken") ? { ok: false, status: 500, text: async () => "" } : hn({ id: "1", title: "HNSW tricks for pgvector retrieval", url: "https://ex.com/hnsw" });
    const { items: found, errors } = await fetchFocused("hn", qs, fetcher, parseFocusResponse);
    expect(found).toHaveLength(1);
    expect(found[0]!.signals?.focus).toEqual({ query: "pgvector", repoIds: ["a", "b"] });
    expect(errors).toHaveLength(1);
  });

  it("fails loudly only when every search fails", async () => {
    await expect(fetchFocused("hn", qs, async () => ({ ok: false, status: 503, text: async () => "" }), parseFocusResponse)).rejects.toThrow(/All hn searches failed/);
  });

  it("only sends arXiv the kinds of term papers use, and parses GitHub search results", async () => {
    const seen: string[] = [];
    await fetchFocused("arxiv", qs, async (u) => (seen.push(u), { ok: true, status: 200, text: async () => "<feed></feed>" }), parseFocusResponse);
    expect(seen.some((u) => u.includes("pgvector"))).toBe(false);
    expect(focusUrl("arxiv", "llm agents")).toContain("all:%22llm%20agents%22");
    const gh = parseFocusResponse("github", JSON.stringify({ items: [{ full_name: "o/r", html_url: "https://github.com/o/r", description: "fast vectors", stargazers_count: 420, created_at: "2026-11-01T00:00:00Z" }] }));
    expect(gh[0]).toMatchObject({ url: "https://github.com/o/r", title: "o/r: fast vectors", signals: { stars: 420 } });
  });
});

describe("focused sweep on the demo workspace", () => {
  const handle = createDb({ memory: true });
  const prompts: { task: string; prompt: string }[] = [];
  const LEDGER_TERMS = ["fintech", "parsing", "correctness", "Fastify", "Postgres", "parser"];
  const STORY = { id: "77", title: "Property tests for hand-written query parser invariants", url: "https://ex.com/parser-props" };
  let ctx: Ctx;

  beforeAll(async () => {
    await handle.ready;
    const base = demoLLM();
    const llm: LLM = { name: "spy", json: (req) => (prompts.push({ task: req.task, prompt: req.prompt }), base.json(req)) };
    ctx = {
      db: handle.db,
      demo: true,
      llm,
      embedder: new HashingEmbedder(),
      github: () => Promise.reject(new Error("offline")),
      writer: async () => new FakeGitHub(),
      token: async () => "t",
      fetcher: async (url) => {
        const q = decodeURIComponent(new URL(url).searchParams.get("query") ?? "");
        return LEDGER_TERMS.includes(q) ? hn(STORY) : hn();
      },
    };
    await seedDemo(ctx);
    await drain(ctx);
  }, 120_000);
  afterAll(() => handle.close());

  it("searches for every demo repo", async () => {
    const qs = await focusQueries(ctx);
    const all = await ctx.db.select({ id: repos.id }).from(repos);
    for (const r of all) expect(qs.some((q) => q.repoIds.includes(r.id))).toBe(true);
  });

  it("tags finds with the repo it searched for, re-triages items dismissed without that context, and matches that repo first", async () => {
    const [ledger] = await ctx.db.select().from(repos).where(eq(repos.fullName, "demo/ledger-api"));
    const [hnSrc] = await ctx.db.select().from(sources).where(eq(sources.url, "demo://hn"));
    await ctx.db.insert(items).values({ tenantId: "local", sourceId: hnSrc!.id, url: STORY.url, title: STORY.title, status: "irrelevant" });
    const [focus] = await ctx.db
      .insert(sources)
      .values({ tenantId: "local", kind: "hn", name: "HN · for your repos", url: "focus://hn", credibility: 45, config: { focus: true } })
      .returning();

    await fetchSourceItems(ctx, focus!.id);
    const [item] = await ctx.db.select().from(items).where(eq(items.url, STORY.url));
    expect(item!.signals.focus?.repoIds).toEqual([ledger!.id]);

    await drain(ctx);
    const triage = prompts.filter((p) => p.task === "triage").at(-1)!;
    expect(triage.prompt).toMatch(/Found searching "[^"]+" for: demo\/ledger-api/);
    const [triaged] = await ctx.db.select().from(items).where(eq(items.url, STORY.url));
    expect(triaged!.techniqueId).toBeTruthy();

    await ctx.db
      .update(techniques)
      .set({ legitimacy: { passed: true, score: 80, verdict: "ok", evidence: [], reasons: [] } as never })
      .where(eq(techniques.id, triaged!.techniqueId!));
    prompts.length = 0;
    await matchTechnique(ctx, triaged!.techniqueId!);
    const match = prompts.find((p) => p.task === "match")!;
    const first = match.prompt.split("\n### ")[1]!;
    expect(first).toMatch(/^demo\/ledger-api\n\(This technique surfaced in a search for/);
  });
});
