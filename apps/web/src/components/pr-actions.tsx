"use client";

import type { PrAction } from "@elevate/engine";
import { GitMerge, GitPullRequestClosed, RefreshCw, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { cn, send } from "@/lib/utils";
import { Button } from "./ui";

const COPY: Record<PrAction, (n: number) => [loading: string, done: string]> = {
  merge: (n) => [`Merging PR #${n}…`, `Merged PR #${n}`],
  close: (n) => [`Closing PR #${n}…`, `Closed PR #${n}`],
  refresh: () => ["Checking the PR…", "PR checked"],
  reverify: () => ["Sending it back for verification…", "Sent back for verification"],
};

/** Merge (your consent for this PR), close, re-check now, or start over. The engine re-checks everything it needs. */
export function PrActions({ swarmId, recommendationId, number, actions }: { swarmId: string; recommendationId: string; number: number; actions: PrAction[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState<PrAction | null>(null);
  const run = (a: PrAction) => {
    const [loading, done] = COPY[a](number);
    setBusy(a);
    const p = (a === "reverify" ? send(`/api/recommendations/${recommendationId}/regate`) : send(`/api/swarms/${swarmId}/pr`, { action: a }))
      .then(() => router.refresh())
      .finally(() => setBusy(null));
    toast.promise(p, { loading, success: done, error: (e: Error) => e.message });
  };
  const has = (a: PrAction) => actions.includes(a);
  return (
    <>
      {has("merge") && (
        <Button variant="primary" size="sm" disabled={busy !== null} onClick={() => run("merge")} data-testid="merge-pr">
          <GitMerge /> Merge
        </Button>
      )}
      {has("reverify") && (
        <Button size="sm" disabled={busy !== null} onClick={() => run("reverify")} data-testid="reverify-pr">
          <RotateCcw /> Re-verify
        </Button>
      )}
      {has("refresh") && (
        <Button size="sm" disabled={busy !== null} onClick={() => run("refresh")} data-testid="refresh-pr">
          <RefreshCw className={cn(busy === "refresh" && "animate-spin")} /> Check now
        </Button>
      )}
      {has("close") && (
        <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => run("close")} data-testid="close-pr">
          <GitPullRequestClosed /> Close PR
        </Button>
      )}
    </>
  );
}
