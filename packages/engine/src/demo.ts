import { emit, enqueue, eq, items, repos, sources, type RepoProfile } from "@elevate/db";
import type { Ctx } from "./context";
import { profileToText } from "./profiler";

const DEMO_REPOS: { fullName: string; description: string; language: string; topics: string[]; profile: RepoProfile }[] = [
  {
    fullName: "demo/ledger-api",
    description: "Double-entry ledger REST API with a custom query parser",
    language: "TypeScript",
    topics: ["fintech", "api", "parser"],
    profile: {
      summary: "A TypeScript REST API for double-entry bookkeeping. Requests are filtered with a hand-written query parser; balances must always reconcile.",
      stack: ["TypeScript", "Node.js", "Fastify", "Postgres", "Vitest"],
      domains: ["fintech", "parsing", "correctness"],
      keyModules: [
        { path: "src/parser/query.ts", purpose: "Hand-written query language parser" },
        { path: "src/ledger/post.ts", purpose: "Posting rules that keep debits equal to credits" },
      ],
      testSetup: "Vitest unit tests for the parser and posting rules",
      improvementSurfaces: ["verification of posting invariants", "parser testing", "property-based testing", "formal proof of balance rules"],
    },
  },
  {
    fullName: "demo/llm-router",
    description: "Self-hosted LLM inference gateway",
    language: "Python",
    topics: ["llm", "inference", "serving"],
    profile: {
      summary: "A Python gateway that routes chat requests to self-hosted LLMs, with batching and a KV cache.",
      stack: ["Python", "FastAPI", "vLLM", "PyTorch"],
      domains: ["llm inference", "serving", "latency"],
      keyModules: [
        { path: "router/decode.py", purpose: "Token decoding loop" },
        { path: "router/batch.py", purpose: "Dynamic request batching" },
      ],
      testSetup: "pytest with a latency benchmark",
      improvementSurfaces: ["decoding latency", "inference throughput", "faster llm inference"],
    },
  },
  {
    fullName: "demo/edge-firmware",
    description: "Sensor firmware for ESP32 boards",
    language: "Rust",
    topics: ["embedded", "rust"],
    profile: {
      summary: "Rust firmware that samples sensors on ESP32 boards and streams frames over UDP.",
      stack: ["Rust", "embassy", "ESP-IDF"],
      domains: ["embedded", "networking"],
      keyModules: [{ path: "src/frame.rs", purpose: "Wire format encoder" }],
      testSetup: "cargo test on the host",
      improvementSurfaces: ["wire format verification", "power usage"],
    },
  },
];

const DEMO_SOURCES = [
  { kind: "rss" as const, name: "Microsoft Research", url: "demo://msr", credibility: 90 },
  { kind: "arxiv" as const, name: "arXiv cs.LG", url: "demo://arxiv", credibility: 80 },
  { kind: "hn" as const, name: "Hacker News", url: "demo://hn", credibility: 60 },
  { kind: "rss" as const, name: "Growth Hacks Weekly", url: "demo://hype", credibility: 20 },
];

const DEMO_ITEMS = [
  {
    source: "demo://msr",
    title: "Proof-driven development: formally verifying agent-written code with Verus",
    url: "https://www.microsoft.com/en-us/research/blog/formally-verifying-agent-written-full-stack-web-apps-with-pdd-kit/",
    content: "Write the intent, state a Verus spec, prove the code meets it for every input, then mutation-check the spec. Proof-driven development keeps agent-written code honest: verification of parser and posting invariants.",
    points: 420,
  },
  {
    source: "demo://arxiv",
    title: "Speculative decoding: faster LLM inference without quality loss",
    url: "https://arxiv.org/abs/2211.17192",
    content: "A small draft model proposes tokens that the large model verifies in parallel, cutting decoding latency 2-3x for llm inference with identical outputs.",
    points: 310,
  },
  {
    source: "demo://hn",
    title: "Property-based testing finds parser bugs that unit tests miss",
    url: "https://news.ycombinator.com/item?id=1",
    content: "Generating thousands of inputs and checking round-trip properties catches parser edge cases. Property-based testing for parser verification.",
    points: 250,
  },
  {
    source: "demo://hype",
    title: "Weight-space programming will replace all your code: one weird performance trick",
    url: "https://example.com/weight-space-hype",
    content: "Edit model weights directly and never write code again. No benchmarks yet, code coming soon.",
    points: 0,
  },
  { source: "demo://hn", title: "Startup raises $50M Series B for AI note-taking", url: "https://example.com/funding", content: "Funding news.", points: 120 },
];

/** Seed an offline demo: three repos, a handful of sources and items, then let the pipeline run. */
export async function seedDemo(ctx: Ctx, tenantId = "local") {
  const existing = await ctx.db.select({ id: repos.id }).from(repos).where(eq(repos.tenantId, tenantId)).limit(1);
  if (existing.length) return false;
  for (const r of DEMO_REPOS) {
    const [owner, name] = r.fullName.split("/") as [string, string];
    const profileText = profileToText(r.fullName, r.profile, r.description);
    const [embedding] = await ctx.embedder.embed([profileText]);
    await ctx.db.insert(repos).values({
      tenantId,
      githubId: Math.abs(hash(r.fullName)),
      fullName: r.fullName,
      owner,
      name,
      description: r.description,
      language: r.language,
      topics: r.topics,
      htmlUrl: `https://github.com/${r.fullName}`,
      pushedAt: new Date(),
      profile: r.profile,
      profileText,
      embedding,
      profiledAt: new Date(),
    });
  }
  const srcRows = await ctx.db
    .insert(sources)
    .values(DEMO_SOURCES.map((s) => ({ ...s, tenantId, enabled: false })))
    .returning({ id: sources.id, url: sources.url });
  const srcByUrl = new Map(srcRows.map((s) => [s.url, s.id]));
  await ctx.db.insert(items).values(
    DEMO_ITEMS.map((i) => ({
      tenantId,
      sourceId: srcByUrl.get(i.source)!,
      url: i.url,
      title: i.title,
      content: i.content,
      publishedAt: new Date(),
      signals: { points: i.points },
    })),
  );
  await emit(ctx.db, { kind: "demo.seeded", level: "success", message: "Demo workspace ready: 3 repos, 5 items to triage", tenantId });
  await enqueue(ctx.db, "items.triage", {}, { dedupeKey: `items.triage:${tenantId}`, tenantId });
  return true;
}

function hash(s: string) {
  let h = 0;
  for (const c of s) h = (Math.imul(31, h) + c.charCodeAt(0)) | 0;
  return h;
}
