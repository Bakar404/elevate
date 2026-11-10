"use client";

import { Ban } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { cn, send } from "@/lib/utils";
import { Badge, Button, type Tone } from "./ui";

const SWARM: Record<string, Tone> = { queued: "neutral", planning: "sky", running: "sky", succeeded: "olive", failed: "danger", cancelled: "neutral" };

export function SwarmStatus({ status }: { status: string }) {
  const live = status === "planning" || status === "running";
  return (
    <Badge tone={SWARM[status] ?? "neutral"} data-status={status}>
      {live && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
      {status}
    </Badge>
  );
}

type Task = { key: string; role: string; title: string; status: string; dependsOn: string[]; output: string | null };

/** Tasks laid out by dependency depth: planner → implementers → tester → reviewer → publisher. */
export function TaskGraph({ tasks }: { tasks: Task[] }) {
  const depth = new Map<string, number>();
  const d = (k: string, seen = new Set<string>()): number => {
    if (depth.has(k)) return depth.get(k)!;
    if (seen.has(k)) return 0;
    seen.add(k);
    const t = tasks.find((x) => x.key === k);
    const v = t && t.dependsOn.length ? 1 + Math.max(...t.dependsOn.map((p) => d(p, seen))) : 0;
    depth.set(k, v);
    return v;
  };
  tasks.forEach((t) => d(t.key));
  const cols = Math.max(0, ...depth.values()) + 1;
  const tone: Record<string, string> = {
    pending: "border-line text-faint",
    running: "border-sky/50 bg-sky/5",
    done: "border-olive/40 bg-olive/5",
    failed: "border-danger/50 bg-danger/5",
    skipped: "border-line text-faint opacity-60",
  };
  return (
    <div className="grid gap-3 overflow-x-auto" style={{ gridTemplateColumns: `repeat(${cols}, minmax(11rem, 1fr))` }} data-testid="task-graph">
      {Array.from({ length: cols }, (_, c) => (
        <div key={c} className="grid content-start gap-3">
          {tasks
            .filter((t) => depth.get(t.key) === c)
            .map((t) => (
              <div key={t.key} className={cn("rounded-xl border p-3 transition-colors duration-300", tone[t.status])} data-task={t.key} data-task-status={t.status}>
                <div className="flex items-center justify-between gap-2 text-[11px] uppercase tracking-wider text-faint">
                  {t.role}
                  {t.status === "running" && <span className="size-1.5 animate-pulse rounded-full bg-sky" />}
                </div>
                <div className="mt-1 text-sm font-medium leading-snug">{t.title}</div>
                {t.output && <div className="mt-1.5 line-clamp-3 text-xs text-muted">{t.output}</div>}
              </div>
            ))}
        </div>
      ))}
    </div>
  );
}

type Ev = { id: number; kind: string; level: string; message: string; swarmId: string | null; createdAt?: string };

/** Starts from the server-rendered log, then appends live events for this swarm. */
export function SwarmLog({ swarmId, initial }: { swarmId: string; initial: Ev[] }) {
  const [rows, setRows] = useState(initial);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => setRows(initial), [initial]);
  useEffect(() => {
    const on = (e: Event) => {
      const ev = (e as CustomEvent<Ev>).detail;
      if (ev.swarmId !== swarmId) return;
      setRows((r) => (r.some((x) => x.id === ev.id) ? r : [...r, ev]));
    };
    window.addEventListener("elevate:event", on);
    return () => window.removeEventListener("elevate:event", on);
  }, [swarmId]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [rows.length]);
  const color: Record<string, string> = { info: "text-muted", success: "text-olive", warn: "text-sand", error: "text-danger" };
  return (
    <div className="max-h-80 overflow-y-auto rounded-xl border border-line bg-bg/60 p-3 font-mono text-xs leading-relaxed" data-testid="swarm-log">
      {rows.length === 0 && <div className="text-faint">Waiting for the first event…</div>}
      {rows.map((e) => (
        <div key={e.id} className={color[e.level] ?? "text-muted"}>
          <span className="text-faint">{String(e.id).padStart(4, " ")} </span>
          {e.message}
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}

export function CancelSwarm({ id }: { id: string }) {
  const router = useRouter();
  return (
    <Button
      variant="danger"
      size="sm"
      onClick={() =>
        toast.promise(send(`/api/swarms/${id}/cancel`).then(() => router.refresh()), {
          loading: "Cancelling…",
          success: "Swarm cancelled",
          error: (e: Error) => e.message,
        })
      }
    >
      <Ban /> Cancel
    </Button>
  );
}
