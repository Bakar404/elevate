import { cosine, tool, type ToolSpec } from "@elevate/agent";
import { and, desc, enqueue, eq, recommendations, repos, techniques } from "@elevate/db";
import { readRepoFile, searchCode } from "@elevate/github";
import { z } from "zod";
import { ECOSYSTEM_LABEL } from "@elevate/sources";
import { accessProfile, accessView } from "./access";
import type { Ctx } from "./context";
import { cuttingEdgeOnly, isCuttingEdge } from "./frontier";
import { listRecommendations } from "./views";

const clip = (s: string, n = 6000) => (s.length > n ? `${s.slice(0, n)}\n…(truncated)` : s);

async function repoByName(ctx: Ctx, fullName: string) {
  const all = await ctx.db.select().from(repos);
  const r = all.find((x) => x.fullName.toLowerCase() === fullName.toLowerCase() || x.name.toLowerCase() === fullName.toLowerCase());
  if (!r) throw new Error(`No repo named ${fullName}. Use list_repos.`);
  return r;
}

/** Read-only tools plus one proposal tool. Nothing here writes to GitHub. */
export function chatTools(ctx: Ctx): ToolSpec[] {
  return [
    tool({
      name: "list_repos",
      description: "List the user's GitHub repositories known to elevate, with language and one-line summary.",
      parameters: z.object({ query: z.string().optional().describe("Filter by name, language or topic") }),
      handler: async ({ query }) => {
        const rows = await ctx.db.select().from(repos).orderBy(desc(repos.pushedAt));
        const q = query?.toLowerCase();
        return rows
          .filter((r) => !q || [r.fullName, r.language ?? "", ...r.topics, r.profile?.summary ?? ""].some((s) => s.toLowerCase().includes(q)))
          .slice(0, 40)
          .map((r) => ({ repo: r.fullName, language: r.language, watch: r.watch, allowSwarm: r.allowSwarm, summary: r.profile?.summary ?? r.description }));
      },
    }),
    tool({
      name: "get_repo",
      description: "Get a repository's technical profile and its current recommendations.",
      parameters: z.object({ repo: z.string().describe("owner/name") }),
      handler: async ({ repo }) => {
        const r = await repoByName(ctx, repo);
        const recs = await ctx.db
          .select({ id: recommendations.id, title: recommendations.title, status: recommendations.status, score: recommendations.score })
          .from(recommendations)
          .where(eq(recommendations.repoId, r.id));
        return { repo: r.fullName, url: r.htmlUrl, profile: r.profile, recommendations: recs };
      },
    }),
    tool({
      name: "read_repo_file",
      description: "Read a file from one of the user's repositories (default branch).",
      parameters: z.object({ repo: z.string(), path: z.string() }),
      handler: async ({ repo, path }) => {
        const r = await repoByName(ctx, repo);
        const text = await readRepoFile(await ctx.github(), r.fullName, path);
        return text == null ? `No file ${path} in ${r.fullName}` : clip(text);
      },
    }),
    tool({
      name: "search_repo_code",
      description: "Search code in one of the user's repositories.",
      parameters: z.object({ repo: z.string(), query: z.string() }),
      handler: async ({ repo, query }) => searchCode(await ctx.github(), (await repoByName(ctx, repo)).fullName, query),
    }),
    tool({
      name: "list_access",
      description: "The AI products and exact model versions this user has access to. Check before suggesting a model, an AI tool or a vendor-specific technique.",
      parameters: z.object({}),
      handler: async () => {
        const a = await accessProfile(ctx);
        return {
          provider: a.provider,
          has: a.ecosystems.map((e) => ECOSYSTEM_LABEL[e]),
          models: a.listed ? a.available.map((m) => m.label) : "not listed by this provider; ask the user which models they use",
        };
      },
    }),
    tool({
      name: "search_radar",
      description:
        "Search techniques discovered from Hacker News, AI labs and papers, with their legitimacy verdicts. cuttingEdge: false marks routine upkeep (patch releases, deprecations, database tips), which isn't recommended while the user wants cutting-edge ideas only.",
      parameters: z.object({ query: z.string(), limit: z.number().int().min(1).max(20).optional() }),
      handler: async ({ query, limit }) => {
        const [q] = await ctx.embedder.embed([query]);
        const rows = await ctx.db.select().from(techniques);
        const access = await accessProfile(ctx);
        const ql = query.toLowerCase();
        return rows
          .map((t) => ({ t, s: (t.embedding ? cosine(q!, t.embedding) : 0) + (t.name.toLowerCase().includes(ql) ? 1 : 0) }))
          .sort((a, b) => b.s - a.s)
          .slice(0, limit ?? 8)
          .map(({ t }) => ({
            name: t.name,
            category: t.category,
            summary: t.summary,
            legitimacy: t.legitimacy ? { passed: t.legitimacy.passed, score: t.legitimacy.score, verdict: t.legitimacy.verdict } : "not checked yet",
            cuttingEdge: isCuttingEdge(t),
            evidence: t.claims.evidenceLinks.slice(0, 3),
            // Say so when the user can't act on it, so the answer doesn't recommend it.
            usableByUser: accessView(t, access).reason ?? true,
          }));
      },
    }),
    tool({
      name: "list_recommendations",
      description:
        "List recommendations, best first for this user. Status 'open' is the inbox (passed both gates, awaiting the user's decision); open ones with heldBack set are filtered out of it (disliked, routine upkeep, or the kind of idea the user usually passes on), so don't push those. vote is the user's like or dislike.",
      parameters: z.object({
        status: z.enum(["candidate", "gated_out", "open", "approved", "rejected", "in_progress", "pr_opened", "merged", "closed", "failed"]).optional(),
      }),
      handler: async ({ status }) => {
        // Same as the inbox: repos the user turned off are left out, and what the user would like comes first.
        const rows = await listRecommendations(ctx, status);
        return [...rows.filter((r) => !r.held), ...rows.filter((r) => r.held)].slice(0, 30).map((r) => ({
          id: r.id,
          title: r.title,
          status: r.status,
          score: r.score,
          repo: r.repo,
          heldBack: r.held?.reason ?? null,
          vote: r.feedback === 1 ? "liked" : r.feedback === -1 ? "disliked" : null,
          likelyToLike: r.fit == null ? null : Math.round(r.fit * 100) / 100,
        }));
      },
    }),
    tool({
      name: "explain_recommendation",
      description: "Show why a recommendation passed or failed each gate, with evidence.",
      parameters: z.object({ id: z.string() }),
      handler: async ({ id }) => {
        const [row] = await ctx.db
          .select({ rec: recommendations, tech: techniques.name })
          .from(recommendations)
          .innerJoin(techniques, eq(recommendations.techniqueId, techniques.id))
          .where(eq(recommendations.id, id));
        if (!row) return `No recommendation ${id}`;
        const { rec } = row;
        return { title: rec.title, technique: row.tech, status: rec.status, hypothesis: rec.hypothesis, legitimacy: rec.gate1, soundness: rec.gate2, history: rec.history };
      },
    }),
    tool({
      name: "propose_recommendation",
      description:
        "Propose a change to one of the user's repos based on a technique on the radar. It is NOT shown to the user unless the technique passed the legitimacy gate and the change then passes the soundness gate.",
      parameters: z.object({
        technique: z.string().describe("Name of a technique from search_radar"),
        repo: z.string(),
        title: z.string().max(80),
        change: z.string(),
        rationale: z.string(),
        expectedImpact: z.string(),
        effort: z.enum(["S", "M", "L"]),
        risk: z.enum(["low", "medium", "high"]),
        touchpoints: z.array(z.string()),
      }),
      handler: async (a) => {
        const r = await repoByName(ctx, a.repo);
        const [t] = (await ctx.db.select().from(techniques).where(and(eq(techniques.tenantId, r.tenantId)))).filter(
          (x) => x.name.toLowerCase() === a.technique.toLowerCase(),
        );
        if (!t) return `Unknown technique "${a.technique}". Use search_radar first.`;
        if (!t.legitimacy?.passed) return `"${t.name}" has not passed the legitimacy gate, so nothing can be proposed from it.`;
        if ((await cuttingEdgeOnly(ctx)) && !isCuttingEdge(t))
          return `"${t.name}" is routine upkeep and the user asked for cutting-edge ideas only (Settings → Recommendations), so nothing is proposed from it.`;
        const [row] = await ctx.db
          .insert(recommendations)
          .values({
            tenantId: r.tenantId,
            techniqueId: t.id,
            repoId: r.id,
            title: a.title,
            relevance: 0.8,
            hypothesis: { change: a.change, rationale: a.rationale, expectedImpact: a.expectedImpact, effort: a.effort, risk: a.risk, touchpoints: a.touchpoints },
          })
          .onConflictDoNothing()
          .returning({ id: recommendations.id });
        if (!row) return `There is already a recommendation applying ${t.name} to ${r.fullName}.`;
        await enqueue(ctx.db, "recommendation.soundness", { recommendationId: row.id }, { dedupeKey: `recommendation.soundness:${row.id}` });
        return `Queued for the soundness gate (id ${row.id}). It reaches the inbox only if it passes.`;
      },
    }),
  ];
}
