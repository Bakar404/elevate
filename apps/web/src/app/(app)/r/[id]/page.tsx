import { getRecommendation } from "@elevate/engine";
import { ArrowLeft, ExternalLink, GitPullRequestDraft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { GateCard } from "@/components/gate-card";
import { StatusBadge } from "@/components/rec";
import { RecActions } from "@/components/rec-actions";
import { Badge, Card, ScoreRing } from "@/components/ui";
import { getCtx } from "@/lib/server";
import { ago } from "@/lib/utils";

export const dynamic = "force-dynamic";

const EVENT_LABEL: Record<string, string> = {
  gate_pass: "Passed both gates",
  gate_fail: "Filtered by a gate",
  approve: "Approved",
  reject: "Rejected",
  start: "Swarm started",
  pr: "Draft PR opened",
  fail: "Swarm failed",
  retry: "Retried",
  regate: "Sent back for verification",
  reopen: "Reopened",
};

export default async function RecommendationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getCtx();
  const r = await getRecommendation(ctx, id).catch(() => undefined);
  if (!r) notFound();
  const h = r.hypothesis;

  return (
    <div className="mx-auto max-w-5xl px-8 py-8">
      <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-muted transition-colors hover:text-fg">
        <ArrowLeft className="size-4" /> Inbox
      </Link>

      <header className="mt-5 flex gap-5">
        <ScoreRing value={r.score} size={64} label="overall score" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-sm text-faint">
            <a href={r.repoUrl} target="_blank" rel="noreferrer" className="font-mono text-muted hover:text-fg">
              {r.repo}
            </a>
            <span>·</span>
            <span>{r.technique}</span>
            <Badge>{r.category}</Badge>
          </div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-balance">{r.title}</h1>
          <div className="mt-3 flex items-center gap-2">
            <StatusBadge status={r.status} />
            <span className="text-xs text-faint">raised {ago(r.createdAt)}</span>
          </div>
        </div>
      </header>

      <div className="mt-6">
        <RecActions id={r.id} status={r.status} repo={r.repo} allowSwarm={r.allowSwarm} demo={ctx.demo} />
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_18rem]">
        <div className="grid min-w-0 gap-6">
          <Card className="p-5">
            <h2 className="text-xs uppercase tracking-wider text-faint">Proposed change</h2>
            <p className="mt-2 text-[15px] leading-relaxed">{h.change}</p>
            <h2 className="mt-5 text-xs uppercase tracking-wider text-faint">Why it fits this repo</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">{h.rationale}</p>
            <h2 className="mt-5 text-xs uppercase tracking-wider text-faint">Expected impact</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">{h.expectedImpact}</p>
            <div className="mt-5 flex flex-wrap gap-1.5">
              <Badge>effort {h.effort}</Badge>
              <Badge tone={h.risk === "high" ? "danger" : h.risk === "medium" ? "sand" : "neutral"}>{h.risk} risk</Badge>
              {h.touchpoints.map((t) => (
                <Badge key={t} className="font-mono">
                  {t}
                </Badge>
              ))}
            </div>
          </Card>

          <GateCard id="legitimacy" title="Gate 1 · Legitimacy" question="Is this technique real: credible sources, corroboration, code or benchmarks?" gate={r.gate1} />
          <GateCard id="soundness" title="Gate 2 · Soundness" question="Does the change fit this codebase and make a measurable difference?" gate={r.gate2} />
        </div>

        <aside className="grid content-start gap-6">
          <Card className="p-5">
            <h2 className="text-xs uppercase tracking-wider text-faint">Technique</h2>
            <p className="mt-2 text-sm text-muted">{r.techniqueSummary}</p>
            {r.claims.claimedBenefits.length > 0 && (
              <ul className="mt-3 space-y-1 text-sm text-muted">
                {r.claims.claimedBenefits.map((c) => (
                  <li key={c}>· {c}</li>
                ))}
              </ul>
            )}
          </Card>

          <Card className="p-5">
            <h2 className="text-xs uppercase tracking-wider text-faint">Sources</h2>
            <ul className="mt-3 space-y-3">
              {r.items.map((it) => (
                <li key={it.url} className="text-sm">
                  <a href={it.url} target="_blank" rel="noreferrer" className="group inline-flex items-start gap-1 text-muted hover:text-fg">
                    <span className="line-clamp-2">{it.title}</span>
                    <ExternalLink className="mt-1 size-3 shrink-0 opacity-50 group-hover:opacity-100" />
                  </a>
                  <div className="text-xs text-faint">
                    {it.source} · credibility {it.credibility}
                    {it.points?.points ? ` · ${it.points.points} pts` : ""}
                  </div>
                </li>
              ))}
            </ul>
          </Card>

          <Card className="p-5">
            <h2 className="text-xs uppercase tracking-wider text-faint">History</h2>
            <ol className="mt-3 space-y-2 border-l border-line pl-4" data-testid="history">
              <li className="relative text-sm text-muted before:absolute before:-left-[19px] before:top-1.5 before:size-1.5 before:rounded-full before:bg-faint">Matched</li>
              {r.history.map((e, i) => (
                <li key={i} data-event={e} className="relative text-sm text-muted before:absolute before:-left-[19px] before:top-1.5 before:size-1.5 before:rounded-full before:bg-sky">
                  {EVENT_LABEL[e] ?? e}
                </li>
              ))}
            </ol>
          </Card>

          {r.swarms.length > 0 && (
            <Card className="p-5">
              <h2 className="text-xs uppercase tracking-wider text-faint">Swarms</h2>
              <ul className="mt-3 space-y-2">
                {r.swarms.map((s) => (
                  <li key={s.id} className="flex items-center gap-2 text-sm">
                    <Link href={`/swarms/${s.id}`} className="text-muted hover:text-fg">
                      {s.executor} · {s.status}
                    </Link>
                    {s.prUrl && (
                      <a href={s.prUrl} target="_blank" rel="noreferrer" className="ml-auto text-olive" aria-label="Draft PR">
                        <GitPullRequestDraft className="size-4" />
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </aside>
      </div>
    </div>
  );
}
