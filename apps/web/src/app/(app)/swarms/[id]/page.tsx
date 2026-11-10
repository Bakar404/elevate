import { getSwarm } from "@elevate/engine";
import { ArrowLeft, ExternalLink, GitPullRequestDraft, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CancelSwarm, SwarmLog, SwarmStatus, TaskGraph } from "@/components/swarm";
import { Badge, Card } from "@/components/ui";
import { getCtx } from "@/lib/server";
import { ago } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function SwarmPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getCtx();
  const s = await getSwarm(ctx, id).catch(() => undefined);
  if (!s) notFound();
  const live = ["queued", "planning", "running"].includes(s.status);
  const events = s.events.map((e) => ({ id: e.id, kind: e.kind, level: e.level, message: e.message, swarmId: e.swarmId }));

  return (
    <div className="mx-auto max-w-6xl px-8 py-8">
      <Link href="/swarms" className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-fg">
        <ArrowLeft className="size-4" /> Swarms
      </Link>
      <header className="mt-5 flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="text-sm text-faint">
            <span className="font-mono text-muted">{s.repo}</span> · {s.executor} · started {ago(s.startedAt ?? s.createdAt)}
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            <Link href={`/r/${s.recommendationId}`} className="hover:underline">
              {s.title}
            </Link>
          </h1>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <SwarmStatus status={s.status} />
            {s.budget && (
              <Badge>
                budget {s.budget.maxTasks} tasks · {s.budget.maxMinutes} min · {s.budget.maxAgentTurns} turns
              </Badge>
            )}
            {s.branch && <Badge className="font-mono">{s.branch}</Badge>}
          </div>
        </div>
        <div className="flex gap-2">
          {s.prUrl && (
            <a
              href={s.prUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="pr-link"
              className="inline-flex h-8 items-center gap-2 rounded-lg border border-olive/40 bg-olive/10 px-3 text-[13px] font-medium text-olive transition-transform active:scale-[0.97]"
            >
              <GitPullRequestDraft className="size-4" /> Draft PR
            </a>
          )}
          {s.issueUrl && (
            <a href={s.issueUrl} target="_blank" rel="noreferrer" className="inline-flex h-8 items-center gap-2 rounded-lg border border-line-strong px-3 text-[13px] text-muted hover:text-fg">
              Issue <ExternalLink className="size-3.5" />
            </a>
          )}
          {live && <CancelSwarm id={s.id} />}
        </div>
      </header>

      {s.error && <Card className="mt-6 border-danger/40 bg-danger/5 p-4 text-sm text-danger">{s.error}</Card>}

      <section className="mt-8">
        <h2 className="mb-3 text-xs uppercase tracking-wider text-faint">Plan</h2>
        {s.tasks.length ? <TaskGraph tasks={s.tasks} /> : <div className="text-sm text-faint">Planning…</div>}
      </section>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_22rem]">
        <section>
          <h2 className="mb-3 text-xs uppercase tracking-wider text-faint">Live log</h2>
          <SwarmLog swarmId={s.id} initial={events} />
        </section>
        <section>
          <h2 className="mb-3 flex items-center gap-1.5 text-xs uppercase tracking-wider text-faint">
            <ShieldCheck className="size-3.5" /> Writes (guarded)
          </h2>
          <Card className="divide-y divide-line text-sm" data-testid="audits">
            {s.audits.length === 0 && <div className="p-4 text-faint">No writes yet.</div>}
            {s.audits.map((a) => (
              <div key={a.id} className="p-3">
                <div className="font-mono text-xs text-muted">{a.action}</div>
                <div className="truncate text-xs text-faint">{a.target}</div>
              </div>
            ))}
          </Card>
        </section>
      </div>
    </div>
  );
}
