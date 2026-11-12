import { and, emit, enqueue, eq, repos, type RepoProfile } from "@elevate/db";
import { branchHead, getRepoContext, listUserRepos } from "@elevate/github";
import type { Ctx } from "./context";
import { PROFILE_SYSTEM, RepoProfileSchema } from "./prompts";

/**
 * Upsert the user's GitHub repos and queue a re-profile for every watched repo whose
 * default branch has a new commit. `pushed_at` (one cheap list call) tells us something was
 * pushed; only then do we ask for the default-branch head, so feature-branch pushes don't
 * trigger a profile.
 */
export async function syncRepos(ctx: Ctx, tenantId = "local", opts: { scheduled?: boolean } = {}) {
  const gh = await ctx.github();
  const remote = await listUserRepos(gh);
  const known = new Map(
    (await ctx.db.select().from(repos).where(eq(repos.tenantId, tenantId))).map((r) => [r.fullName, r]),
  );
  let queued = 0;
  for (const r of remote) {
    const prev = known.get(r.fullName);
    const pushedAt = r.pushedAt ? new Date(r.pushedAt) : null;
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
      pushedAt,
    };
    const [row] = await ctx.db
      .insert(repos)
      .values({ ...values, watch: !r.archived && !r.fork })
      .onConflictDoUpdate({ target: [repos.tenantId, repos.fullName], set: { ...values, updatedAt: new Date() } })
      .returning();
    if (!row || !row.watch || row.archived) continue;

    const moved =
      !prev || !row.headSha || prev.defaultBranch !== row.defaultBranch || (prev.pushedAt?.getTime() ?? 0) !== (pushedAt?.getTime() ?? 0);
    let head = row.headSha;
    if (moved) {
      head = (await branchHead(gh, row.fullName, row.defaultBranch)) ?? null;
      // Profiles from before SHAs were tracked: adopt the head if nothing was pushed since.
      const adopt = head && !row.profiledSha && row.profiledAt && (!pushedAt || pushedAt <= row.profiledAt);
      if (head !== row.headSha || adopt) {
        const set = { headSha: head, ...(adopt ? { profiledSha: head } : {}) };
        await ctx.db.update(repos).set(set).where(eq(repos.id, row.id));
        Object.assign(row, set);
      }
    }
    const stale = !row.profiledAt || (head ? head !== row.profiledSha : !!pushedAt && pushedAt > row.profiledAt);
    if (stale) {
      await enqueue(ctx.db, "repo.profile", { repoId: row.id }, { dedupeKey: `repo.profile:${row.id}` });
      queued++;
    }
  }
  if (!opts.scheduled || queued > 0) {
    await emit(ctx.db, {
      kind: "repos.synced",
      message: `Synced ${remote.length} repositories, ${queued} queued for profiling`,
      level: "success",
    });
  }
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
  // Turned off after this was queued: don't spend a model call on it. Turning it back on re-queues it.
  if (!repo.watch) return repo.profile;
  const gh = await ctx.github();
  const head = (await branchHead(gh, repo.fullName, repo.defaultBranch)) ?? repo.headSha;
  const context = await getRepoContext(gh, repo.fullName, head ?? repo.defaultBranch);

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

  const profile = await ctx.llm.json({ task: "profile", system: PROFILE_SYSTEM, prompt, schema: RepoProfileSchema });
  const profileText = profileToText(repo.fullName, profile, repo.description);
  const [embedding] = await ctx.embedder.embed([profileText]);

  await ctx.db
    .update(repos)
    .set({ profile, profileText, embedding, profiledAt: new Date(), headSha: head, profiledSha: head, updatedAt: new Date() })
    .where(eq(repos.id, repo.id));
  await emit(ctx.db, {
    kind: "repo.profiled",
    message: `Profiled ${repo.fullName}${head ? ` at ${head.slice(0, 7)}` : ""}`,
    data: { repoId: repo.id, sha: head },
  });
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
