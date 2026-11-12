"use client";

import { Check, Play, RotateCcw, ShieldAlert, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { EXECUTORS, cn, send } from "@/lib/utils";
import { Button, Dialog, Switch } from "./ui";

export function RecActions({ id, status, repo, allowSwarm, autoMerge, demo }: { id: string; status: string; repo: string; allowSwarm: boolean; autoMerge: boolean; demo: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const act = (action: string, label: string, data: unknown = {}) =>
    toast.promise(
      send(`/api/recommendations/${id}/${action}`, data).then(() => router.refresh()),
      { loading: `${label}…`, success: `${label}: done`, error: (e: Error) => e.message },
    );

  return (
    <div className="flex flex-wrap gap-2">
      {status === "open" && (
        <>
          <Button variant="primary" onClick={() => setOpen(true)} data-testid="approve">
            <Check /> Approve & launch swarm
          </Button>
          <Button variant="ghost" onClick={() => act("reject", "Reject")}>
            <X /> Reject
          </Button>
        </>
      )}
      {status === "failed" && (
        <>
          <Button onClick={() => act("retry", "Retry swarm")}>
            <Play /> Retry swarm
          </Button>
          <Button variant="ghost" onClick={() => act("reject", "Reject")}>
            <X /> Reject
          </Button>
        </>
      )}
      {(status === "gated_out" || status === "rejected" || status === "open" || status === "closed") && (
        <Button variant="ghost" onClick={() => act("regate", "Re-verify")} data-testid="reverify">
          <RotateCcw /> Re-verify
        </Button>
      )}
      <ApproveDialog open={open} onOpenChange={setOpen} id={id} repo={repo} allowSwarm={allowSwarm} autoMerge={autoMerge} demo={demo} onDone={() => router.refresh()} />
    </div>
  );
}

function ApproveDialog({
  open,
  onOpenChange,
  id,
  repo,
  allowSwarm,
  autoMerge,
  demo,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  id: string;
  repo: string;
  allowSwarm: boolean;
  autoMerge: boolean;
  demo: boolean;
  onDone: () => void;
}) {
  const options = demo ? [{ id: "fake", label: "Simulated swarm", detail: "Demo mode: runs the full plan without touching GitHub." }, ...EXECUTORS] : EXECUTORS;
  const [executor, setExecutor] = useState<string>(options[0]!.id);
  const [allowRepo, setAllowRepo] = useState(allowSwarm);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    const p = send<{ swarm: { id: string } }>(`/api/recommendations/${id}/approve`, { executor, allowRepo });
    toast.promise(p, { loading: "Launching swarm…", success: "Swarm launched. It will open a draft PR.", error: (e: Error) => e.message });
    try {
      await p;
      onOpenChange(false);
      onDone();
    } catch {
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Launch a swarm"
      description={
        <>
          Agents plan, implement, test and review the change, then open a <strong className="text-fg">draft</strong> PR on {repo}. It merges only once its
          checks pass: {autoMerge ? "auto-merge is on, so elevate merges it then." : "you click Merge, or turn on auto-merge in Settings."}
        </>
      }
    >
      <div className="grid gap-2" role="radiogroup" aria-label="Executor">
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={executor === o.id}
            onClick={() => setExecutor(o.id)}
            className={cn(
              "rounded-xl border px-3.5 py-2.5 text-left transition-[border-color,background-color] duration-150",
              executor === o.id ? "border-sky/50 bg-sky/10" : "border-line hover:border-line-strong",
            )}
          >
            <div className="text-sm font-medium">{o.label}</div>
            <div className="text-xs text-muted">{o.detail}</div>
          </button>
        ))}
      </div>
      {!allowSwarm && (
        <label className="mt-4 flex items-start gap-3 rounded-xl border border-sand/30 bg-sand/5 p-3.5 text-sm">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-sand" />
          <span className="flex-1">
            <span className="font-medium">Allow swarms on {repo}</span>
            <span className="block text-xs text-muted">This repo isn't on the allow-list yet. Swarms can only write to repos you opt in.</span>
          </span>
          <Switch checked={allowRepo} onCheckedChange={setAllowRepo} data-testid="allow-repo" />
        </label>
      )}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" onClick={submit} disabled={busy || (!allowSwarm && !allowRepo)} data-testid="launch">
          Launch swarm
        </Button>
      </div>
    </Dialog>
  );
}
