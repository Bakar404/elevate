"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { toast } from "sonner";

type Ev = { id: number; kind: string; level: "info" | "success" | "warn" | "error"; message: string; swarmId: string | null; data?: { by?: string } | null };

/**
 * Worth interrupting for: gate verdicts, finished swarms, failures. Per-task chatter stays in the swarm view,
 * and what you just did yourself (by: "you") already has its own toast.
 */
const toastable = (e: Ev) =>
  e.kind !== "swarm.task" && e.data?.by !== "you" && (e.level !== "info" || e.kind === "gate.soundness" || e.kind === "repos.synced");

/** Tails /api/events and refreshes server components (throttled). Notable events become toasts. */
export function LiveRefresh() {
  const router = useRouter();
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/events");
    const refresh = () => {
      if (pending.current) return;
      pending.current = setTimeout(() => {
        pending.current = null;
        router.refresh();
      }, 800);
    };
    es.addEventListener("event", (m) => {
      const e = JSON.parse((m as MessageEvent).data) as Ev;
      window.dispatchEvent(new CustomEvent("elevate:event", { detail: e }));
      refresh();
      if (!toastable(e)) return;
      const fn = e.level === "error" ? toast.error : e.level === "success" ? toast.success : e.level === "warn" ? toast.warning : toast;
      fn(e.message, { id: `ev-${e.id}` });
    });
    return () => {
      es.close();
      if (pending.current) clearTimeout(pending.current);
    };
  }, [router]);

  return null;
}
