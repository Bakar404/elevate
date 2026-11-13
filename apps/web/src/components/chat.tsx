"use client";

import { ArrowUp, Bot, Loader2, MessagesSquare, Plus, Square, Trash2, Wrench, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { toast } from "sonner";
import { cn, send } from "@/lib/utils";
import { usePipClearance } from "./mascot";
import { ModelPicker, useModels } from "./model-picker";
import { Badge, Button, Dialog, ShimmerText } from "./ui";

type Tool = { id: string; name: string; ok?: boolean };
type Msg = { id: string; role: "user" | "assistant"; content: string; tools: Tool[]; pending?: boolean };
type Thread = { id: string; title: string; model: string | null };

const SUGGESTIONS = [
  "What should I upgrade first, and why?",
  "Which techniques on the radar did you filter out as hype?",
  "Explain the top recommendation's evidence.",
  "List my repos and what they're built with.",
];

/** Parses an SSE byte stream into `data:` JSON payloads. */
async function* sseEvents(res: Response) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => l.slice(6))
        .join("\n");
      if (data) yield JSON.parse(data) as { type: string; text?: string; id?: string; name?: string; ok?: boolean; message?: string };
    }
  }
}

export function Chat({ threads: initial, demo }: { threads: Thread[]; demo: boolean }) {
  const [threads, setThreads] = useState(initial);
  const [active, setActive] = useState<string | null>(initial[0]?.id ?? null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLFormElement>(null);
  usePipClearance(composer);

  const fresh = useRef<string | null>(null);
  const { data: catalog } = useModels();
  /** Model picked before the first message, applied when the conversation is created. */
  const [draftModel, setDraftModel] = useState("");
  const [confirm, setConfirm] = useState<Thread | null>(null);
  const [drawer, setDrawer] = useState(false);
  const activeThread = threads.find((t) => t.id === active);
  const model = activeThread ? (activeThread.model ?? "") : draftModel;
  const chatDefault = catalog?.prefs.chat || catalog?.prefs.pipeline || "";
  const nameOf = (id: string) => catalog?.models.find((m) => m.id === id)?.name ?? id;
  const defaultLabel = chatDefault ? `Default (${nameOf(chatDefault)})` : "Default model";

  const pickModel = async (id: string) => {
    if (!activeThread) return setDraftModel(id);
    const prev = activeThread.model;
    setThreads((ts) => ts.map((t) => (t.id === activeThread.id ? { ...t, model: id || null } : t)));
    try {
      await send(`/api/threads/${activeThread.id}`, { model: id || null }, "PATCH");
    } catch (e) {
      setThreads((ts) => ts.map((t) => (t.id === activeThread.id ? { ...t, model: prev } : t)));
      toast.error((e as Error).message);
    }
  };

  const remove = async (t: Thread) => {
    setConfirm(null);
    const before = threads;
    const rest = threads.filter((x) => x.id !== t.id);
    setThreads(rest);
    if (active === t.id) setActive(rest[0]?.id ?? null);
    try {
      await send(`/api/threads/${t.id}`, {}, "DELETE");
      toast.success("Conversation deleted");
    } catch (e) {
      setThreads(before);
      toast.error((e as Error).message);
    }
  };

  useEffect(() => {
    if (!active) {
      setMsgs([]);
      return;
    }
    if (fresh.current === active) {
      fresh.current = null;
      return;
    }
    let stale = false;
    fetch(`/api/threads/${active}`)
      .then((r) => r.json())
      .then((rows: { id: string; role: "user" | "assistant"; content: string; toolCalls: { name: string }[] }[]) => {
        if (!stale && Array.isArray(rows)) setMsgs(rows.map((m) => ({ id: m.id, role: m.role, content: m.content, tools: m.toolCalls.map((t, i) => ({ id: `${m.id}-${i}`, name: t.name, ok: true })) })));
      });
    return () => {
      stale = true;
    };
  }, [active]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [msgs]);

  const newThread = async (keep = false) => {
    let t = await send<Thread>("/api/threads");
    if (draftModel) {
      t = await send<Thread>(`/api/threads/${t.id}`, { model: draftModel }, "PATCH");
      setDraftModel("");
    }
    if (keep) fresh.current = t.id;
    setThreads((ts) => [t, ...ts]);
    setActive(t.id);
    return t.id;
  };

  const submit = async (text = input) => {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setInput("");
    setBusy(true);
    const threadId = active ?? (await newThread(true));
    const aid = crypto.randomUUID();
    setMsgs((m) => [...m, { id: crypto.randomUUID(), role: "user", content: prompt, tools: [] }, { id: aid, role: "assistant", content: "", tools: [], pending: true }]);
    const patch = (fn: (m: Msg) => Msg) => setMsgs((ms) => ms.map((m) => (m.id === aid ? fn(m) : m)));
    abort.current = new AbortController();
    try {
      const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ threadId, prompt }), signal: abort.current.signal });
      if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `Chat failed (${res.status})`);
      for await (const e of sseEvents(res)) {
        if (e.type === "delta") patch((m) => ({ ...m, content: m.content + (e.text ?? "") }));
        else if (e.type === "message") patch((m) => ({ ...m, content: e.text ?? m.content }));
        else if (e.type === "tool_start") patch((m) => ({ ...m, tools: [...m.tools, { id: e.id!, name: e.name! }] }));
        else if (e.type === "tool_end") patch((m) => ({ ...m, tools: m.tools.map((t) => (t.id === e.id ? { ...t, ok: e.ok } : t)) }));
        else if (e.type === "error") toast.error(e.message ?? "The agent hit an error");
      }
      setThreads((ts) => ts.map((t) => (t.id === threadId && t.title === "New conversation" ? { ...t, title: prompt.slice(0, 60) } : t)));
    } catch (err) {
      if ((err as Error).name !== "AbortError") toast.error((err as Error).message);
    } finally {
      patch((m) => ({ ...m, pending: false }));
      setBusy(false);
      abort.current = null;
    }
  };

  const threadList = (onPick?: () => void) => (
    <div className="mt-3 flex-1 space-y-0.5 overflow-y-auto" data-testid={onPick ? "threads-mobile" : "threads"}>
      {threads.map((t) => (
        <div
          key={t.id}
          data-testid={onPick ? "thread-mobile" : "thread"}
          className={cn("group flex items-center rounded-md transition-colors", t.id === active ? "bg-ink/[0.06] text-fg" : "text-muted hover:bg-ink/[0.03] hover:text-fg")}
        >
          <button onClick={() => { setActive(t.id); onPick?.(); }} className="min-w-0 flex-1 truncate px-2.5 py-2 lg:py-1.5 text-left text-sm" aria-current={t.id === active ? "true" : undefined}>
            {t.title}
          </button>
          <button
            type="button"
            aria-label={`Delete "${t.title}"`}
            title="Delete conversation"
            disabled={busy && t.id === active}
            onClick={() => setConfirm(t)}
            className="mr-1 grid size-6 shrink-0 place-items-center rounded text-faint opacity-0 transition-opacity pointer-coarse:size-9 pointer-coarse:opacity-100 hover:text-danger focus-visible:opacity-100 group-hover:opacity-100 disabled:hidden"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );

  return (
    // data-pip-lift: Pip stands on the composer here instead of the page's end (see the app layout's main).
    <div data-pip-lift className="flex h-dvh max-md:h-[calc(100dvh-7.5rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))]">
      <aside className="flex w-60 shrink-0 flex-col border-r border-line p-3 max-lg:hidden">
        <Button size="sm" className="w-full" onClick={() => setActive(null)}>
          <Plus /> New chat
        </Button>
        {threadList()}
      </aside>

      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden" data-testid="threads-drawer" onKeyDown={(e) => e.key === "Escape" && setDrawer(false)}>
          <button type="button" aria-label="Close conversations" className="absolute inset-0 bg-black/50" onClick={() => setDrawer(false)} />
          <div className="absolute inset-y-0 left-0 flex w-[min(20rem,85vw)] flex-col border-r border-line bg-bg p-3 pt-[max(0.75rem,env(safe-area-inset-top))] shadow-2xl motion-safe:animate-drawer-in">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Conversations</span>
              <Button size="icon" variant="ghost" className="ml-auto" aria-label="Close" onClick={() => setDrawer(false)}>
                <X />
              </Button>
            </div>
            {threads.length ? threadList(() => setDrawer(false)) : <p className="mt-6 text-center text-sm text-faint">No conversations yet.</p>}
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2 lg:hidden">
          <Button size="sm" variant="ghost" onClick={() => setDrawer(true)} aria-label="Conversations" data-testid="threads-open">
            <MessagesSquare /> Chats{threads.length > 0 && <span className="tabular-nums text-faint">{threads.length}</span>}
          </Button>
          <span className="min-w-0 flex-1 truncate text-center text-sm text-muted">{activeThread?.title ?? "New chat"}</span>
          <Button size="icon" variant="ghost" onClick={() => setActive(null)} aria-label="New chat">
            <Plus />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
            {msgs.length === 0 ? (
              <div className="pt-[12vh] text-center">
                <div className="mx-auto grid size-11 place-items-center rounded-xl border border-line-strong bg-panel">
                  <Bot className="size-5 text-sky" />
                </div>
                <h1 className="mt-4 text-xl font-semibold tracking-tight">Ask about your repos and what's new</h1>
                <p className="mt-1 text-sm text-muted">
                  The agent can read your repos, search the radar and explain or propose recommendations.
                  {demo && " (Demo mode: answers come from sample data.)"}
                </p>
                <div className="mx-auto mt-8 grid max-w-xl gap-2 sm:grid-cols-2">
                  {SUGGESTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => submit(s)}
                      className="rounded-xl border border-line bg-panel/60 px-4 py-3 text-left text-sm text-muted transition-[border-color,color,transform] duration-150 hover:border-line-strong hover:text-fg active:scale-[0.98]"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="space-y-6" data-testid="messages">
                {msgs.map((m) =>
                  m.role === "user" ? (
                    <div key={m.id} className="flex justify-end">
                      <div className="max-w-[80%] rounded-2xl rounded-br-md bg-raised px-4 py-2.5 text-[15px]">{m.content}</div>
                    </div>
                  ) : (
                    <div key={m.id} className="flex gap-3" data-role="assistant">
                      <div className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-lg border border-line-strong bg-panel">
                        <Bot className="size-3.5 text-sky" />
                      </div>
                      <div className="min-w-0 flex-1">
                        {m.tools.length > 0 && (
                          <div className="mb-2 flex flex-wrap gap-1.5">
                            {m.tools.map((t) => (
                              <Badge key={t.id} tone={t.ok === false ? "danger" : t.ok ? "neutral" : "sky"} className="font-mono" data-testid="tool-chip">
                                {t.ok === undefined ? <Loader2 className="animate-spin" /> : <Wrench />}
                                {t.name}
                              </Badge>
                            ))}
                          </div>
                        )}
                        {m.content ? (
                          <div className="prose-chat text-[15px] leading-relaxed text-muted">
                            <Markdown>{m.content}</Markdown>
                          </div>
                        ) : (
                          m.pending && <ShimmerText className="text-sm">Thinking…</ShimmerText>
                        )}
                      </div>
                    </div>
                  ),
                )}
                {/* Tall enough that the corner Pip doesn't sit on the last message when it scrolls into view. */}
                <div ref={end} className="md:pip-on:h-16" />
              </div>
            )}
          </div>
        </div>

        <form
          ref={composer}
          className="mx-auto w-full max-w-3xl px-4 pb-4 sm:px-6 sm:pb-6"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="rounded-2xl border border-line-strong bg-panel p-2 transition-colors focus-within:border-sky/40">
          <div className="flex items-end gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              rows={1}
              placeholder="Ask the agent…"
              aria-label="Message"
              className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] outline-none placeholder:text-faint [field-sizing:content]"
            />
            {busy ? (
              <Button type="button" size="icon" variant="secondary" onClick={() => abort.current?.abort()} aria-label="Stop">
                <Square />
              </Button>
            ) : (
              <Button type="submit" size="icon" variant="primary" disabled={!input.trim()} aria-label="Send">
                <ArrowUp />
              </Button>
            )}
          </div>
          <div className="mt-1 flex items-center gap-2 px-1">
            <ModelPicker compact label="Chat model" value={model} models={catalog?.models ?? []} defaultLabel={defaultLabel} onChange={pickModel} disabled={busy} />
            {activeThread?.model && msgs.length > 0 && <span className="text-[11px] text-faint">applies from your next message</span>}
          </div>
        </div>
        </form>
      </div>
      <Dialog
        open={confirm !== null}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Delete this conversation?"
        description={confirm ? `"${confirm.title}" and all its messages will be removed. This can't be undone.` : undefined}
      >
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>
            Cancel
          </Button>
          <Button size="sm" variant="danger" onClick={() => confirm && remove(confirm)} data-testid="confirm-delete">
            <Trash2 /> Delete
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
