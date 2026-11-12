import { copilotLogin } from "@elevate/agent";
import { deleteSecret, enqueue, getSecret, getSetting, setSecret, setSetting, audit } from "@elevate/db";
import { accessProfile, autoMerge, DEFAULT_BUDGET, ECOSYSTEMS, ECOSYSTEM_LABEL, modelPrefs, recheckAccess, setAccessOverrides, publishAsMe, resetGitHubClient, resolveModelConfig, setModelPrefs, swarmBudget, thresholds } from "@elevate/engine";
import { ghAccountToken, GITHUB_ACCOUNT_SETTING, resolveGitHubToken } from "@elevate/github";
import { NextResponse } from "next/server";
import { z } from "zod";
import { body, route } from "@/lib/api";

export const dynamic = "force-dynamic";

type RouteCtx = Parameters<Parameters<typeof route>[0]>[0];

async function githubStatus(ctx: RouteCtx) {
  if (ctx.demo) return { connected: true, login: "demo", source: "demo" as const, account: null, accountFrom: null };
  const stored = Boolean(await getSecret(ctx.db, "github_token"));
  // The gh account elevate is held to: GITHUB_USER, else the one pinned here. Otherwise gh's active account.
  const pinned = (await getSetting<string>(ctx.db, GITHUB_ACCOUNT_SETTING, "")) || null;
  const account = process.env.GITHUB_USER || pinned;
  const accountFrom = process.env.GITHUB_USER ? ("env" as const) : pinned ? ("pinned" as const) : null;
  try {
    const gh = await ctx.github();
    const { data } = await gh.users.getAuthenticated();
    return { connected: true, login: data.login, source: stored ? ("stored" as const) : process.env.GITHUB_TOKEN ? ("env" as const) : ("gh" as const), account, accountFrom };
  } catch (err) {
    const hasToken = await resolveGitHubToken(ctx.db).then(() => true, () => false);
    return { connected: false, login: null, source: hasToken ? ("invalid" as const) : ("none" as const), error: err instanceof Error ? err.message : String(err), account, accountFrom };
  }
}

/** Whose Copilot usage the model calls count against, as the Copilot runtime reports it. */
async function copilotStatus(ctx: RouteCtx, model: Awaited<ReturnType<typeof resolveModelConfig>>) {
  if (ctx.demo || model.provider !== "copilot") return null;
  try {
    return { login: (await copilotLogin(model.account)) ?? null };
  } catch (err) {
    return { login: null, error: err instanceof Error ? err.message : String(err) };
  }
}

async function accessStatus(ctx: RouteCtx) {
  const a = await accessProfile(ctx);
  return {
    provider: a.provider,
    listed: a.listed,
    models: a.available.map((m) => m.label),
    options: ECOSYSTEMS.map((id) => ({
      id,
      label: ECOSYSTEM_LABEL[id],
      on: a.ecosystems.includes(id),
      detected: a.detected.includes(id),
      /** True when the user's own switch differs from what the connection implies. */
      overridden: a.overrides[id] !== undefined && a.overrides[id] !== a.detected.includes(id),
    })),
  };
}

export const GET = route(async (ctx) => {
  const model = await resolveModelConfig(ctx.db);
  return {
    access: await accessStatus(ctx),
    demo: ctx.demo,
    model: { provider: model.provider, model: model.model ?? "", baseUrl: model.baseUrl ?? "", hasApiKey: Boolean(model.apiKey) },
    models: await modelPrefs(ctx),
    github: await githubStatus(ctx),
    copilot: await copilotStatus(ctx, model),
    executor: await getSetting(ctx.db, "executor.default", ctx.demo ? "fake" : "copilot-cloud"),
    thresholds: await thresholds(ctx),
    budget: await swarmBudget(ctx),
    publishAsMe: await publishAsMe(ctx),
    autoMerge: await autoMerge(ctx),
    defaults: { budget: DEFAULT_BUDGET },
  };
});

const Put = z.object({
  model: z.object({ provider: z.enum(["copilot", "anthropic", "openai", "azure"]), model: z.string().max(100), baseUrl: z.string().max(300) }).partial().optional(),
  models: z.object({ pipeline: z.string().max(100), chat: z.string().max(100), codingAgent: z.string().max(100) }).partial().optional(),
  apiKey: z.string().max(500).nullable().optional(),
  githubToken: z.string().max(500).nullable().optional(),
  /** gh account to hold GitHub calls and Copilot usage to; null goes back to gh's active account. */
  githubAccount: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/, "not a GitHub username")
    .nullable()
    .optional(),
  executor: z.enum(["copilot-cloud", "claude-action", "codex-cloud", "local", "fake"]).optional(),
  thresholds: z.object({ legitimacy: z.number().int().min(0).max(100), priorFloor: z.number().int().min(0).max(100), soundness: z.number().int().min(0).max(100) }).partial().optional(),
  budget: z.object({ maxTasks: z.number().int().min(1).max(20), maxMinutes: z.number().int().min(5).max(600), maxAgentTurns: z.number().int().min(1).max(200) }).partial().optional(),
  publishAsMe: z.boolean().optional(),
  /** Merge swarm PRs once every check passed and GitHub can merge them. */
  autoMerge: z.boolean().optional(),
  /** true/false = the user's own switch; null = go back to what the connection implies. */
  access: z.partialRecord(z.enum(ECOSYSTEMS), z.boolean().nullable()).optional(),
});

export const PUT = route(async (ctx, req) => {
  const p = Put.parse(await body(req));
  if (p.githubAccount && !(await ghAccountToken(p.githubAccount))) {
    return NextResponse.json({ error: `gh has no login for ${p.githubAccount}. Run \`gh auth login\` as ${p.githubAccount} first.` }, { status: 400 });
  }
  if (p.model) await setSetting(ctx.db, "model", { ...(await getSetting(ctx.db, "model", {})), ...p.model });
  if (p.models) await setModelPrefs(ctx, p.models);
  if (p.apiKey !== undefined) await (p.apiKey ? setSecret(ctx.db, "provider_api_key", p.apiKey) : deleteSecret(ctx.db, "provider_api_key"));
  if (p.githubToken !== undefined) {
    await (p.githubToken ? setSecret(ctx.db, "github_token", p.githubToken) : deleteSecret(ctx.db, "github_token"));
    resetGitHubClient();
  }
  if (p.githubAccount !== undefined) {
    // The Copilot runtime and chat sessions follow the account on their next use.
    await setSetting(ctx.db, GITHUB_ACCOUNT_SETTING, p.githubAccount ?? "");
    resetGitHubClient();
  }
  if (p.executor) await setSetting(ctx.db, "executor.default", p.executor);
  if (p.thresholds) await setSetting(ctx.db, "gates.thresholds", { ...(await getSetting(ctx.db, "gates.thresholds", {})), ...p.thresholds });
  if (p.publishAsMe !== undefined) await setSetting(ctx.db, "swarm.publishAsMe", p.publishAsMe);
  if (p.autoMerge !== undefined) {
    await setSetting(ctx.db, "swarm.autoMerge", p.autoMerge);
    // Merge PRs that are already verified now, not at the next scheduled check.
    if (p.autoMerge) await enqueue(ctx.db, "prs.track", {}, { dedupeKey: "prs.track" });
  }
  if (p.budget) await setSetting(ctx.db, "swarm.budget", { ...(await getSetting(ctx.db, "swarm.budget", {})), ...p.budget });
  if (p.access) await setAccessOverrides(ctx, p.access);
  // What the user can act on may have changed: pick up techniques that were held back.
  if (p.access || p.model || p.executor) await recheckAccess(ctx);
  const changed = Object.keys(p).map((k) => (k === "apiKey" || k === "githubToken" ? `${k}:${p[k as "apiKey"] ? "set" : "cleared"}` : k));
  await audit(ctx.db, "user", "settings.update", "settings", { changed });
  return { ok: true };
});
