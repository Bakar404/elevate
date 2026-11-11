import { HashingEmbedder, type ModelRole } from "@elevate/agent";
import { createDb, recommendations, repos } from "@elevate/db";
import { FakeGitHub, getExecutor } from "@elevate/executors";
import { describe, expect, it, vi } from "vitest";
import { approveRecommendation, demoLLM, drain, profileRepo, seedDemo, type Ctx } from "../src";

vi.mock("@elevate/github", async (importOriginal) => ({
  ...await importOriginal<typeof import("@elevate/github")>(),
  getRepoContext: vi.fn(async () => ({
    languages: { TypeScript: 100 },
    recentCommits: [],
    tree: ["src/index.ts", "test/index.test.ts"],
    manifests: [],
    readme: "Offline repository fixture",
  })),
}));

vi.mock("@elevate/executors", async (importOriginal) => {
  const original = await importOriginal<typeof import("@elevate/executors")>();
  return { ...original, getExecutor: vi.fn(original.getExecutor) };
});

describe("engine model roles", () => {
  it.each([
    { name: "configured defaults", models: undefined },
    { name: "explicit per-role overrides", models: { gate1: "gate-one", gate2: "gate-two", matcher: "matching", swarm: "swarming" } },
    { name: "a partial override", models: { gate1: "gate-one" } },
  ] satisfies { name: string; models: Ctx["models"] }[])("forwards roles and models with $name", async ({ models }) => {
    const handle = createDb({ memory: true });
    try {
      await handle.ready;
      const llm = demoLLM();
      const ctx: Ctx = {
        db: handle.db,
        demo: true,
        llm,
        models,
        embedder: new HashingEmbedder(),
        github: () => Promise.reject(new Error("offline")),
        writer: async () => new FakeGitHub(),
        token: async () => "demo",
        fetcher: async () => { throw new Error("offline"); },
      };
      await seedDemo(ctx);
      await drain(ctx);

      const rec = (await ctx.db.select().from(recommendations)).find((r) => r.status === "open");
      expect(rec).toBeDefined();
      vi.mocked(getExecutor).mockClear();
      await approveRecommendation(ctx, rec!.id, { executor: "fake", allowRepo: true });
      await drain(ctx);
      expect(getExecutor).toHaveBeenCalledWith("fake", { model: ctx.models?.swarm });

      const [repo] = await ctx.db.select().from(repos);
      await profileRepo({
        ...ctx,
        github: async () => ({}) as Awaited<ReturnType<Ctx["github"]>>,
      }, repo!.id);

      const roles: Record<string, ModelRole> = { legitimacy: "gate1", soundness: "gate2", match: "matcher", profile: "matcher", plan: "swarm" };
      for (const [task, role] of Object.entries(roles)) {
        const calls = llm.calls.filter((call) => call.task === task);
        expect(calls.length, `${task} should run against offline fixtures`).toBeGreaterThan(0);
        for (const call of calls) {
          expect(call.role).toBe(role);
          expect(call.model).toBe(ctx.models?.[role]);
        }
      }
    } finally {
      await handle.close();
    }
  }, 120_000);
});
