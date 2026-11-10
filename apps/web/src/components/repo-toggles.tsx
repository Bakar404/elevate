"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { send } from "@/lib/utils";
import { Switch, Tip } from "./ui";

export function RepoToggles({ id, name, watch, allowSwarm }: { id: string; name: string; watch: boolean; allowSwarm: boolean }) {
  const router = useRouter();
  const [state, setState] = useState({ watch, allowSwarm });
  const update = async (patch: Partial<typeof state>) => {
    const prev = state;
    setState({ ...state, ...patch });
    try {
      await send(`/api/repos/${id}`, patch, "PATCH");
      if (patch.allowSwarm !== undefined) toast.success(patch.allowSwarm ? `Swarms may open draft PRs on ${name}` : `Swarms blocked on ${name}`);
      router.refresh();
    } catch (e) {
      setState(prev);
      toast.error((e as Error).message);
    }
  };
  return (
    <div className="flex items-center gap-5 text-xs text-muted">
      <Tip content="Match new techniques against this repo">
        <label className="flex items-center gap-2">
          Watch <Switch checked={state.watch} onCheckedChange={(v) => update({ watch: v })} aria-label={`Watch ${name}`} />
        </label>
      </Tip>
      <Tip content="Let approved swarms open draft PRs here">
        <label className="flex items-center gap-2">
          Swarms <Switch checked={state.allowSwarm} onCheckedChange={(v) => update({ allowSwarm: v })} aria-label={`Allow swarms on ${name}`} />
        </label>
      </Tip>
    </div>
  );
}

export function ActionButton({ url, label, children }: { url: string; label: string; children: React.ReactNode }) {
  const router = useRouter();
  return (
    <button
      className="inline-flex h-8 items-center gap-2 rounded-lg border border-line-strong bg-raised/70 px-3 text-[13px] font-medium transition-[transform,background-color] duration-150 ease-[var(--ease-out)] hover:bg-raised active:scale-[0.97] [&_svg]:size-4"
      onClick={() =>
        toast.promise(
          send<{ queued: boolean; message?: string }>(url).then((r) => {
            router.refresh();
            return r;
          }),
          { loading: `${label}…`, success: (r) => r.message ?? `${label} queued`, error: (e: Error) => e.message },
        )
      }
    >
      {children}
    </button>
  );
}
