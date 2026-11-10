import { forgetThread, listCopilotModels, type ModelConfig, type ModelOption } from "@elevate/agent";
import { eq, getSetting, setSetting, threads } from "@elevate/db";
import type { Ctx } from "./context";
import { resolveModelConfig } from "./context";

/** Shown in demo mode so the pickers have something real-looking to choose from. */
export const DEMO_MODELS: ModelOption[] = [
  { id: "gpt-5-mini", name: "GPT-5 mini", vendor: "openai", multiplier: 0, enabled: true },
  { id: "claude-sonnet-4.5", name: "Claude Sonnet 4.5", vendor: "anthropic", multiplier: 1, enabled: true },
  { id: "gpt-5", name: "GPT-5", vendor: "openai", multiplier: 1, enabled: true },
  { id: "claude-opus-4.1", name: "Claude Opus 4.1", vendor: "anthropic", multiplier: 10, enabled: false },
];

const CACHE_MS = 10 * 60_000;
let cache: { at: number; models: ModelOption[] } | undefined;

/**
 * Models the user can pick. With Copilot as the provider this is the seat's live model list;
 * with a bring-your-own-key provider the runtime can't enumerate them, so the list is empty
 * and the UI takes a typed model id instead.
 */
export async function availableModels(ctx: Ctx): Promise<{ provider: ModelConfig["provider"]; models: ModelOption[]; error?: string }> {
  if (ctx.demo) return { provider: "copilot", models: DEMO_MODELS };
  const { provider } = await resolveModelConfig(ctx.db);
  if (provider !== "copilot") return { provider, models: [] };
  if (cache && Date.now() - cache.at < CACHE_MS) return { provider, models: cache.models };
  try {
    const models = await listCopilotModels();
    cache = { at: Date.now(), models };
    return { provider, models };
  } catch (err) {
    return { provider, models: [], error: err instanceof Error ? err.message : String(err) };
  }
}

export type ModelPrefs = {
  /** Background work: triage, profiling, both gates, swarm planning. Empty = provider default. */
  pipeline: string;
  /** Default for new chats. Empty = same as pipeline. */
  chat: string;
};

export async function modelPrefs(ctx: Ctx): Promise<ModelPrefs> {
  const base = await getSetting<{ model?: string }>(ctx.db, "model", {});
  const chat = await getSetting<string>(ctx.db, "model.chat", "");
  return { pipeline: base.model ?? "", chat };
}

export async function setModelPrefs(ctx: Ctx, p: Partial<ModelPrefs>) {
  if (p.pipeline !== undefined) await setSetting(ctx.db, "model", { ...(await getSetting(ctx.db, "model", {})), model: p.pipeline });
  if (p.chat !== undefined) await setSetting(ctx.db, "model.chat", p.chat);
}

/** thread's own pick → chat default → pipeline model → provider default. */
export async function chatModelConfig(ctx: Ctx, threadId: string): Promise<ModelConfig> {
  const base = await resolveModelConfig(ctx.db);
  const [t] = await ctx.db.select({ model: threads.model }).from(threads).where(eq(threads.id, threadId));
  const chat = await getSetting<string>(ctx.db, "model.chat", "");
  const model = t?.model || chat || base.model;
  return { ...base, model: model || undefined };
}

export async function setThreadModel(ctx: Ctx, threadId: string, model: string | null) {
  const [t] = await ctx.db.update(threads).set({ model: model || null }).where(eq(threads.id, threadId)).returning();
  return t;
}

/** Deletes the conversation and its messages, and drops its live model session. */
export async function deleteThread(ctx: Ctx, threadId: string) {
  forgetThread(threadId);
  const rows = await ctx.db.delete(threads).where(eq(threads.id, threadId)).returning({ id: threads.id });
  return { deleted: rows.length };
}
