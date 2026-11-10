import type { CopilotSession } from "@github/copilot-sdk";
import { createSession, type ModelConfig, type ToolSpec } from "./copilot";

export type ChatEvent =
  | { type: "delta"; text: string }
  | { type: "tool_start"; id: string; name: string; args?: unknown }
  | { type: "tool_end"; id: string; name: string; ok: boolean }
  | { type: "message"; text: string }
  | { type: "error"; message: string }
  | { type: "done" };

type ChatEntry = { session: CopilotSession; lastUsed: number; busy: boolean };
const KEY = Symbol.for("elevate.chat");
type G = typeof globalThis & { [KEY]?: Map<string, ChatEntry> };

function registry(): Map<string, ChatEntry> {
  const g = globalThis as G;
  g[KEY] ??= new Map();
  return g[KEY];
}

export type ChatTurn = {
  threadId: string;
  config: ModelConfig;
  system: string;
  tools: ToolSpec[];
  /** Previous messages, replayed when the thread's live session was lost (restart). */
  history: { role: "user" | "assistant"; content: string }[];
  prompt: string;
  onEvent: (e: ChatEvent) => void;
  signal?: AbortSignal;
};

/** Run one chat turn on the thread's live Copilot session, streaming events as they arrive. */
export async function runChatTurn(turn: ChatTurn): Promise<{ text: string; toolCalls: { name: string; args?: unknown }[] }> {
  const reg = registry();
  let entry = reg.get(turn.threadId);
  let prompt = turn.prompt;
  if (!entry) {
    const session = await createSession({
      config: turn.config,
      system: turn.system,
      tools: turn.tools,
      builtIns: ["web_fetch"],
      streaming: true,
    });
    entry = { session, lastUsed: Date.now(), busy: false };
    reg.set(turn.threadId, entry);
    if (turn.history.length) {
      const transcript = turn.history
        .slice(-12)
        .map((m) => `${m.role.toUpperCase()}: ${m.content.slice(0, 2000)}`)
        .join("\n\n");
      prompt = `<previous_conversation>\n${transcript}\n</previous_conversation>\n\n${turn.prompt}`;
    }
  }
  if (entry.busy) throw new Error("This conversation is still answering the previous message.");
  entry.busy = true;
  entry.lastUsed = Date.now();

  const { session } = entry;
  const toolCalls: { name: string; args?: unknown }[] = [];
  const names = new Map<string, string>();
  let text = "";

  const unsubscribers: (() => void)[] = [];
  const on = (type: string, fn: (data: Record<string, unknown>) => void) => {
    const off = (session.on as (t: string, h: (e: { data: Record<string, unknown> }) => void) => () => void)(type, (e) =>
      fn(e.data),
    );
    unsubscribers.push(off);
  };

  try {
    const finished = new Promise<void>((resolve, reject) => {
      on("assistant.message_delta", (d) => {
        if (d.parentToolCallId) return;
        turn.onEvent({ type: "delta", text: String(d.deltaContent ?? "") });
      });
      on("tool.execution_start", (d) => {
        const id = String(d.toolCallId ?? Math.random());
        const name = String(d.toolName ?? d.mcpToolName ?? "tool");
        names.set(id, name);
        toolCalls.push({ name, args: d.arguments });
        turn.onEvent({ type: "tool_start", id, name, args: d.arguments });
      });
      on("tool.execution_complete", (d) => {
        const id = String(d.toolCallId ?? "");
        turn.onEvent({ type: "tool_end", id, name: names.get(id) ?? "tool", ok: !d.error });
      });
      on("assistant.message", (d) => {
        if (d.parentToolCallId) return;
        // A turn with tool calls yields several assistant messages; the answer is all of them, in order.
        const content = String(d.content ?? "").trim();
        if (content) {
          text = text ? `${text}\n\n${content}` : content;
          turn.onEvent({ type: "message", text: content });
        }
      });
      on("session.error", (d) => reject(new Error(String(d.message ?? "Copilot session error"))));
      on("session.idle", () => resolve());
    });
    turn.signal?.addEventListener("abort", () => void session.abort?.().catch(() => {}));
    await session.send({ prompt });
    await finished;
    turn.onEvent({ type: "done" });
    return { text, toolCalls };
  } catch (err) {
    reg.delete(turn.threadId);
    await session.disconnect().catch(() => {});
    throw err;
  } finally {
    entry.busy = false;
    unsubscribers.forEach((off) => off());
  }
}

export function forgetThread(threadId: string) {
  const entry = registry().get(threadId);
  registry().delete(threadId);
  void entry?.session.disconnect().catch(() => {});
}
