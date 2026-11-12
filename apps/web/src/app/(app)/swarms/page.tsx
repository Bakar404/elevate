import { listSwarms } from "@elevate/engine";
import { Cpu } from "lucide-react";
import Link from "next/link";
import { PrIcon, prState } from "@/components/pr";
import { SwarmStatus } from "@/components/swarm";
import { Badge, Empty, SpotlightCard } from "@/components/ui";
import { getCtx } from "@/lib/server";
import { ago } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function SwarmsPage() {
  const ctx = await getCtx();
  const rows = await listSwarms(ctx);
  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-8 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Swarms</h1>
      <p className="mt-1 text-sm text-muted">
        Approved changes, carried out by agents. Every swarm ends in a pull request or a clear failure. elevate follows each PR&apos;s checks and merges it only
        once they pass: when you click Merge, or on its own if auto-merge is on in Settings.
      </p>
      <div className="mt-8 grid gap-3">
        {rows.length === 0 && (
          <Empty icon={<Cpu />} title="No swarms yet">
            Approve a recommendation from the Inbox to launch one.
          </Empty>
        )}
        {rows.map((s) => (
          <SpotlightCard key={s.id}>
            <Link href={`/swarms/${s.id}`} className="flex items-center gap-4 p-5" data-testid="swarm-row">
              <div className="min-w-0 flex-1">
                <div className="text-xs text-faint">
                  <span className="font-mono text-muted">{s.repo}</span> · {s.executor} · {ago(s.createdAt)}
                </div>
                <div className="mt-1 truncate font-medium">{s.title}</div>
                {s.error && <div className="mt-1 truncate text-xs text-danger">{s.error}</div>}
              </div>
              {s.next ? (
                <Badge tone={s.next.tone} data-testid="pr-stage" data-stage={s.next.stage}>
                  <PrIcon state={prState(s.pr, s.next.stage)} draft={s.pr?.draft} className="text-current" /> {s.next.short}
                </Badge>
              ) : (
                s.prUrl && <PrIcon state="open" draft className="size-4" />
              )}
              <SwarmStatus status={s.status} />
            </Link>
          </SpotlightCard>
        ))}
      </div>
    </div>
  );
}
