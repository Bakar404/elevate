import { listSwarms } from "@elevate/engine";
import { Cpu, GitPullRequestDraft } from "lucide-react";
import Link from "next/link";
import { SwarmStatus } from "@/components/swarm";
import { Empty, SpotlightCard } from "@/components/ui";
import { getCtx } from "@/lib/server";
import { ago } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function SwarmsPage() {
  const ctx = await getCtx();
  const rows = await listSwarms(ctx);
  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Swarms</h1>
      <p className="mt-1 text-sm text-muted">Approved changes, carried out by agents. Every swarm ends in a draft PR or a clear failure; nothing merges on its own.</p>
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
              {s.prUrl && <GitPullRequestDraft className="size-4 text-olive" />}
              <SwarmStatus status={s.status} />
            </Link>
          </SpotlightCard>
        ))}
      </div>
    </div>
  );
}
