"use client";

import { ArrowUp, Bot, Loader2, Plus, Square, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { toast } from "sonner";
import { cn, send } from "@/lib/utils";
import { Badge, Button, ShimmerText } from "./ui";

type Tool = { id: string; name: string; ok?: boolean };
type Msg = { id: string; role: "user" | "assistant"; content: string; tools: Tool[]; pending?: boolean };
type Thread = { id: string; title: string };

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

  const fresh = useRef<string | null>(null);

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
    const t = await send<Thread>("/api/threads");
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

  return (
    <div className="flex h-dvh">
      <aside className="flex w-60 shrink-0 flex-col border-r border-line p-3 max-lg:hidden">
        <Button size="sm" className="w-full" onClick={() => newThread()}>
          <Plus /> New chat
        </Button>
        <div className="mt-3 flex-1 space-y-0.5 overflow-y-auto">
          {threads.map((t) => (
            <button
              key={t.id}
              onClick={() => setActive(t.id)}
              className={cn("block w-full truncate rounded-md px-2.5 py-1.5 text-left text-sm transition-colors", t.id === active ? "bg-white/[0.06] text-fg" : "text-muted hover:text-fg")}
            >
              {t.title}
            </button>
          ))}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-6 py-10">
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
                <div ref={end} />
              </div>
            )}
          </div>
        </div>

        <form
          className="mx-auto w-full max-w-3xl px-6 pb-6"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div className="flex items-end gap-2 rounded-2xl border border-line-strong bg-panel p-2 transition-colors focus-within:border-sky/40">
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
        </form>
      </div>
    </div>
  );
}
