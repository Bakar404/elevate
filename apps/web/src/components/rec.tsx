import type { RecommendationRow } from "@elevate/engine";
import { ArrowUpRight, GitPullRequestDraft } from "lucide-react";
import Link from "next/link";
import { ago } from "@/lib/utils";
import { Badge, ScoreRing, SpotlightCard, type Tone } from "./ui";

export const STATUS: Record<string, { label: string; tone: Tone }> = {
  candidate: { label: "verifying", tone: "sky" },
  gated_out: { label: "filtered", tone: "neutral" },
  open: { label: "ready for review", tone: "olive" },
  approved: { label: "approved", tone: "sky" },
  rejected: { label: "rejected", tone: "neutral" },
  in_progress: { label: "swarm running", tone: "sky" },
  pr_opened: { label: "draft PR open", tone: "olive" },
  failed: { label: "swarm failed", tone: "danger" },
};

export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: "neutral" as Tone };
  return (
    <Badge tone={s.tone} data-status={status}>
      {status === "in_progress" && <span className="size-1.5 animate-pulse rounded-full bg-current" />}
      {s.label}
    </Badge>
  );
}

const effort: Record<string, string> = { S: "small", M: "medium", L: "large" };

export function RecCard({ r, index = 0 }: { r: RecommendationRow; index?: number }) {
  return (
    <SpotlightCard className="animate-fade-up" style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}>
      <Link href={`/r/${r.id}`} className="flex gap-4 p-5" data-testid="rec-card">
        <ScoreRing value={r.score} label="score" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-faint">
            <span className="font-mono text-muted">{r.repo}</span>
            <span>·</span>
            <span>{r.technique}</span>
            <span>·</span>
            <span>{ago(r.createdAt)}</span>
          </div>
          <h3 className="mt-1 text-[15px] font-medium leading-snug text-fg">{r.title}</h3>
          <p className="mt-1.5 line-clamp-2 text-sm text-muted">{r.hypothesis.expectedImpact}</p>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <StatusBadge status={r.status} />
            <Badge>effort {effort[r.hypothesis.effort] ?? r.hypothesis.effort}</Badge>
            <Badge tone={r.hypothesis.risk === "high" ? "danger" : r.hypothesis.risk === "medium" ? "sand" : "neutral"}>{r.hypothesis.risk} risk</Badge>
            {r.status === "pr_opened" && (
              <Badge tone="olive">
                <GitPullRequestDraft /> draft PR
              </Badge>
            )}
          </div>
        </div>
        <ArrowUpRight className="size-4 shrink-0 text-faint opacity-0 transition-opacity duration-150 group-hover/spot:opacity-100" />
      </Link>
    </SpotlightCard>
  );
}
