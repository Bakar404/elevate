import type { RecommendationRow } from "@elevate/engine";
import { ArrowUpRight, Ban, EyeOff, Sparkles, ThumbsDown, Wrench } from "lucide-react";
import Link from "next/link";
import { ago } from "@/lib/utils";
import { PrIcon } from "./pr";
import { Badge, ScoreRing, SpotlightCard, type Tone } from "./ui";
import { VoteButtons } from "./vote";

export const STATUS: Record<string, { label: string; tone: Tone }> = {
  candidate: { label: "verifying", tone: "sky" },
  gated_out: { label: "filtered", tone: "neutral" },
  open: { label: "ready for review", tone: "olive" },
  approved: { label: "approved", tone: "sky" },
  rejected: { label: "rejected", tone: "neutral" },
  in_progress: { label: "swarm running", tone: "sky" },
  pr_opened: { label: "PR open", tone: "olive" },
  merged: { label: "merged", tone: "olive" },
  closed: { label: "PR closed", tone: "neutral" },
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

/** Why an open recommendation is under Filtered out instead of Ready for review. The full reason is the badge's title. */
export const HELD: Record<string, { label: string; icon: typeof Ban }> = {
  access: { label: "not for your setup", icon: Ban },
  disliked: { label: "you disliked this", icon: ThumbsDown },
  routine: { label: "routine upkeep", icon: Wrench },
  learned: { label: "you usually pass on these", icon: EyeOff },
};

/** The embedding-similarity labels read as a clause of their own: "it's like ideas you liked". */
const LIKE_ONES = /^ideas like ones (.+)$/;

/**
 * "you've gone for …; you've passed on …", from what in the user's votes moved the estimate. Past tense,
 * because it is true from the first vote ("usually" is kept for ideas held back after several).
 */
export function whyText(why: { toward: string[]; away: string[] } | null) {
  if (!why) return "";
  const say = (labels: string[], verb: string) => {
    const plain = labels.filter((l) => !LIKE_ONES.test(l));
    const similar = labels.flatMap((l) => l.match(LIKE_ONES)?.[1] ?? []).map((who) => `it's like ideas ${who}`);
    return [plain.length ? `${verb} ${plain.join(" and ")}` : "", ...similar];
  };
  return [...say(why.toward, "you've gone for"), ...say(why.away, "you've passed on")].filter(Boolean).join("; ");
}

export function RecCard({ r, index = 0 }: { r: RecommendationRow; index?: number }) {
  const held = r.held && !r.blocked ? (HELD[r.held.kind] ?? HELD.learned!) : null;
  const HeldIcon = held?.icon;
  const why = whyText(r.why);
  return (
    <SpotlightCard className="animate-fade-up" style={{ animationDelay: `${Math.min(index, 8) * 40}ms` }}>
      <div className="flex gap-4 p-5" data-testid="rec" data-id={r.id} data-held={r.held?.kind}>
        <ScoreRing value={r.score} label="score" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs text-faint">
            <span className="font-mono text-muted">{r.repo}</span>
            <span>·</span>
            <span>{r.technique}</span>
            <span>·</span>
            <span>{ago(r.createdAt)}</span>
          </div>
          <h3 className="mt-1 text-[15px] font-medium leading-snug text-fg">
            {/* The link stretches over the whole card; the vote buttons sit above it. */}
            <Link href={`/r/${r.id}`} className="after:absolute after:inset-0" data-testid="rec-card">
              {r.title}
            </Link>
          </h3>
          <p className="mt-1.5 line-clamp-2 text-sm text-muted">{r.hypothesis.expectedImpact}</p>
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            <StatusBadge status={r.status} />
            {r.blocked && (
              <Badge tone="sand" title={r.blocked}>
                <Ban /> not for your setup
              </Badge>
            )}
            {held && HeldIcon && (
              <Badge tone="sand" title={r.held!.reason} data-testid="held-reason" data-kind={r.held!.kind}>
                <HeldIcon /> {held.label}
              </Badge>
            )}
            {r.status === "open" && !r.held && r.fit != null && (
              <Badge tone={r.fit >= 0.6 ? "olive" : "neutral"} title={`How likely you are to like it, learned from your votes${why ? `: ${why}` : ""}`} data-testid="fit">
                <Sparkles /> {Math.round(r.fit * 100)}% your kind
              </Badge>
            )}
            <Badge>effort {effort[r.hypothesis.effort] ?? r.hypothesis.effort}</Badge>
            <Badge tone={r.hypothesis.risk === "high" ? "danger" : r.hypothesis.risk === "medium" ? "sand" : "neutral"}>{r.hypothesis.risk} risk</Badge>
            {r.status === "pr_opened" && r.pr && (
              <Badge tone={r.pr.next.tone} data-testid="pr-stage" data-stage={r.pr.next.stage}>
                <PrIcon state="open" className="text-current" /> {r.pr.next.short}
              </Badge>
            )}
            <VoteButtons id={r.id} feedback={r.feedback} status={r.status} className="ml-auto" />
          </div>
        </div>
        <ArrowUpRight className="size-4 shrink-0 text-faint opacity-0 transition-opacity duration-150 group-hover/spot:opacity-100" />
      </div>
    </SpotlightCard>
  );
}
