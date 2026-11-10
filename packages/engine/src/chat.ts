import { runChatTurn, type ChatEvent, type ToolSpec } from "@elevate/agent";
import { asc, eq, messages, threads, type ToolCallRecord } from "@elevate/db";
import type { Ctx } from "./context";
import { resolveModelConfig } from "./context";
import { CHAT_SYSTEM } from "./prompts";
import { chatTools } from "./tools";

export async function createThread(ctx: Ctx, title = "New conversation") {
  const [t] = await ctx.db.insert(threads).values({ title }).returning();
  return t!;
}

/** Answer one user message on a thread, streaming events; both messages are saved. */
export async function chat(ctx: Ctx, threadId: string, prompt: string, onEvent: (e: ChatEvent) => void, signal?: AbortSignal) {
  const history = await ctx.db
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(asc(messages.createdAt));
  await ctx.db.insert(messages).values({ threadId, role: "user", content: prompt });
  if (!history.length) await ctx.db.update(threads).set({ title: prompt.slice(0, 60), updatedAt: new Date() }).where(eq(threads.id, threadId));

  const tools = chatTools(ctx);
  const calls: ToolCallRecord[] = [];
  const record = (e: ChatEvent) => {
    if (e.type === "tool_start") calls.push({ name: e.name, args: e.args });
    onEvent(e);
  };
  let text: string;
  try {
    text = ctx.demo
      ? await demoChat(tools, prompt, record)
      : (await runChatTurn({ threadId, config: await resolveModelConfig(ctx.db), system: CHAT_SYSTEM, tools, history, prompt, onEvent: record, signal })).text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onEvent({ type: "error", message });
    text = `Something went wrong: ${message}`;
  }
  await ctx.db.insert(messages).values({ threadId, role: "assistant", content: text, toolCalls: calls });
  await ctx.db.update(threads).set({ updatedAt: new Date() }).where(eq(threads.id, threadId));
  return text;
}

/** Offline stand-in for the model: routes the question to one real tool and summarises the result. */
async function demoChat(tools: ToolSpec[], prompt: string, onEvent: (e: ChatEvent) => void) {
  const q = prompt.toLowerCase();
  const pick = /repo/.test(q) ? "list_repos" : /radar|technique|new|paper|hn|hacker/.test(q) ? "search_radar" : "list_recommendations";
  const t = tools.find((x) => x.name === pick)!;
  const args = pick === "search_radar" ? { query: prompt } : pick === "list_recommendations" ? { status: "open" } : {};
  onEvent({ type: "tool_start", id: "demo-1", name: pick, args });
  const result = (await t.handler(args as never)) as unknown[];
  onEvent({ type: "tool_end", id: "demo-1", name: pick, ok: true });
  const lines = (Array.isArray(result) ? result : []).slice(0, 6).map((r) => {
    const o = r as Record<string, unknown>;
    if (pick === "list_repos") return `- **${o.repo}** (${o.language ?? "?"}): ${o.summary ?? ""}`;
    if (pick === "search_radar") {
      const l = o.legitimacy as { passed?: boolean; score?: number } | string;
      return `- **${o.name}**: ${typeof l === "string" ? l : l.passed ? `legit (${l.score})` : `not legit (${l.score})`}`;
    }
    return `- **${o.title}** on ${o.repo} (score ${Math.round(Number(o.score))})`;
  });
  const head =
    pick === "list_repos" ? "Here are your repos:" : pick === "search_radar" ? "From the radar:" : "Open recommendations that passed both gates:";
  const text = `${head}\n\n${lines.join("\n") || "- nothing yet"}\n\n_Demo mode: answers come from the real tools, phrased by a stand-in model._`;
  for (const chunk of text.match(/[\s\S]{1,24}/g) ?? []) onEvent({ type: "delta", text: chunk });
  onEvent({ type: "message", text });
  onEvent({ type: "done" });
  return text;
}
