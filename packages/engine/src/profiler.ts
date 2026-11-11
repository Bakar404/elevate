import { and, emit, enqueue, eq, repos, type RepoProfile } from "@elevate/db";
import { getRepoContext, listUserRepos } from "@elevate/github";
import type { Ctx } from "./context";
import { PROFILE_SYSTEM, RepoProfileSchema } from "./prompts";

/** Upsert the user's GitHub repos and queue profiling for anything new or changed. */
export async function syncRepos(ctx: Ctx, tenantId = "local") {
  const gh = await ctx.github();
  const remote = await listUserRepos(gh);
  let queued = 0;
  for (const r of remote) {
    const values = {
      tenantId,
      githubId: r.githubId,
      fullName: r.fullName,
      owner: r.owner,
      name: r.name,
      description: r.description,
      defaultBranch: r.defaultBranch,
      language: r.language,
      topics: r.topics,
      stars: r.stars,
      isPrivate: r.isPrivate,
      archived: r.archived,
      fork: r.fork,
      htmlUrl: r.htmlUrl,
      pushedAt: r.pushedAt ? new Date(r.pushedAt) : null,
    };
    const [row] = await ctx.db
      .insert(repos)
      .values({ ...values, watch: !r.archived && !r.fork })
      .onConflictDoUpdate({ target: [repos.tenantId, repos.fullName], set: { ...values, updatedAt: new Date() } })
      .returning();
    if (!row) continue;
    const stale = !row.profiledAt || (row.pushedAt && row.pushedAt > row.profiledAt);
    if (row.watch && stale) {
      await enqueue(ctx.db, "repo.profile", { repoId: row.id }, { dedupeKey: `repo.profile:${row.id}` });
      queued++;
    }
  }
  await emit(ctx.db, {
    kind: "repos.synced",
    message: `Synced ${remote.length} repositories, ${queued} queued for profiling`,
    level: "success",
  });
  return { total: remote.length, queued };
}

export function profileToText(fullName: string, p: RepoProfile, description?: string | null): string {
  return [
    fullName,
    description ?? "",
    p.summary,
    `Stack: ${p.stack.join(", ")}`,
    `Domains: ${p.domains.join(", ")}`,
    `Modules: ${p.keyModules.map((m) => `${m.path} (${m.purpose})`).join("; ")}`,
    `Tests: ${p.testSetup}`,
    `Improvement surfaces: ${p.improvementSurfaces.join("; ")}`,
  ].join("\n");
}

export async function profileRepo(ctx: Ctx, repoId: string) {
  const [repo] = await ctx.db.select().from(repos).where(eq(repos.id, repoId));
  if (!repo) throw new Error(`Repo ${repoId} not found`);
  const gh = await ctx.github();
  const context = await getRepoContext(gh, repo.fullName, repo.defaultBranch);

  const prompt = [
    `Repository: ${repo.fullName}`,
    `Description: ${repo.description ?? "(none)"}`,
    `Primary language: ${repo.language ?? "unknown"}; topics: ${repo.topics.join(", ") || "none"}`,
    `Languages (bytes): ${JSON.stringify(context.languages)}`,
    `Recent commits:\n${context.recentCommits.map((c) => `- ${c}`).join("\n") || "(none)"}`,
    `File tree (truncated):\n${context.tree.join("\n") || "(empty)"}`,
    ...context.manifests.map((m) => `--- ${m.path} ---\n${m.content}`),
    `--- README ---\n${context.readme || "(none)"}`,
  ].join("\n\n");

  const profile = await ctx.llm.json({ task: "profile", role: "matcher", model: ctx.models?.matcher, system: PROFILE_SYSTEM, prompt, schema: RepoProfileSchema });
  const profileText = profileToText(repo.fullName, profile, repo.description);
  const [embedding] = await ctx.embedder.embed([profileText]);

  await ctx.db
    .update(repos)
    .set({ profile, profileText, embedding, profiledAt: new Date(), updatedAt: new Date() })
    .where(eq(repos.id, repo.id));
  await emit(ctx.db, { kind: "repo.profiled", message: `Profiled ${repo.fullName}`, data: { repoId: repo.id } });
  await enqueue(ctx.db, "repo.match", { repoId: repo.id }, { dedupeKey: `repo.match:${repo.id}` });
  return profile;
}

export async function watchedProfiledRepos(ctx: Ctx, tenantId = "local") {
  const rows = await ctx.db
    .select()
    .from(repos)
    .where(and(eq(repos.tenantId, tenantId), eq(repos.watch, true)));
  return rows.filter((r) => r.profile && r.embedding);
}
