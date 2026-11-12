import type { PrNextStep, PrStage, SwarmPr } from "@elevate/engine";
import { CircleCheck, CircleDashed, CircleMinus, CircleX, ExternalLink, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, Zap } from "lucide-react";
import Link from "next/link";
import { ago, cn } from "@/lib/utils";
import { PrActions } from "./pr-actions";
import { Badge, Card } from "./ui";

export function PrIcon({ state, draft, className }: { state: "open" | "closed" | "merged"; draft?: boolean; className?: string }) {
  if (state === "merged") return <GitMerge className={cn("text-olive", className)} aria-label="merged" />;
  if (state === "closed") return <GitPullRequestClosed className={cn("text-faint", className)} aria-label="closed" />;
  if (draft) return <GitPullRequestDraft className={cn("text-olive", className)} aria-label="draft" />;
  return <GitPullRequest className={cn("text-olive", className)} aria-label="open" />;
}

export const prState = (pr: SwarmPr | null | undefined, stage: PrStage) =>
  stage === "merged" ? "merged" : stage === "closed" ? "closed" : (pr?.state ?? "open");

export const prNumber = (url: string, pr?: SwarmPr | null) => pr?.number ?? Number(/\/pull\/(\d+)/.exec(url)?.[1] ?? 0);

const CHECK = {
  passed: { Icon: CircleCheck, cls: "text-olive", label: "passed" },
  neutral: { Icon: CircleMinus, cls: "text-faint", label: "skipped" },
  failing: { Icon: CircleX, cls: "text-danger", label: "failed" },
  pending: { Icon: CircleDashed, cls: "animate-spin text-sky [animation-duration:3s]", label: "running" },
} as const;

/** Stages where elevate is still following the PR, so auto-merge applies. */
const FOLLOWED = new Set<PrStage>(["unchecked", "repo_off", "approval", "failing", "running", "no_checks", "unmergeable", "refused", "merging", "ready"]);

const link = "inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px] text-muted transition-colors hover:bg-ink/5 hover:text-fg [&_svg]:size-3.5";

/** A swarm's pull request: what it's waiting on, its checks, and what you can do next. */
export function PrPanel({
  swarmId,
  recommendationId,
  repo,
  url,
  pr,
  next,
  autoMerge,
  showReverify = true,
  className,
}: {
  swarmId: string;
  recommendationId: string;
  repo: string;
  url: string;
  pr: SwarmPr | null | undefined;
  next: PrNextStep;
  autoMerge: boolean;
  /** Off where the page already has its own Re-verify button. */
  showReverify?: boolean;
  className?: string;
}) {
  const number = prNumber(url, pr);
  const actions = showReverify ? next.actions : next.actions.filter((a) => a !== "reverify");
  return (
    <Card className={cn("p-5", className)} data-testid="pr-panel" data-stage={next.stage}>
      <div className="flex items-start gap-3">
        <PrIcon state={prState(pr, next.stage)} draft={pr?.draft} className="mt-0.5 size-5 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-medium">{next.title}</h2>
            <Badge tone={next.tone} data-testid="pr-stage">
              {next.short}
            </Badge>
          </div>
          <p className="mt-1 text-sm text-pretty text-muted">{next.detail}</p>
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-faint">
            <a href={url} target="_blank" rel="noreferrer" className="min-w-0 truncate hover:text-fg hover:underline">
              {repo}#{number}
              {pr?.title ? ` · ${pr.title}` : ""}
            </a>
            {pr && (
              <span className="font-mono">
                {pr.headRef} → {pr.baseRef} @ {pr.headSha.slice(0, 7)}
              </span>
            )}
            {pr && <span>checked {ago(pr.checkedAt)}</span>}
          </div>
        </div>
      </div>

      {pr && pr.checks.length > 0 && (
        <ul className="mt-4 divide-y divide-line rounded-lg border border-line text-sm" data-testid="pr-checks">
          {pr.checks.map((c, i) => {
            const { Icon, cls, label } = CHECK[c.state];
            return (
              <li key={`${c.name}-${i}`} className="flex items-center gap-2 px-3 py-2" data-check-state={c.state}>
                <Icon className={cn("size-4 shrink-0", cls)} aria-hidden />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                <span className="text-xs text-faint">{label}</span>
                {c.url && (
                  <a href={c.url} target="_blank" rel="noreferrer" className="text-faint hover:text-fg" aria-label={`Open ${c.name} on GitHub`}>
                    <ExternalLink className="size-3.5" />
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <PrActions swarmId={swarmId} recommendationId={recommendationId} number={number} actions={actions} />
        <a href={url} target="_blank" rel="noreferrer" className={link} data-testid="open-pr">
          Open PR <ExternalLink />
        </a>
        {(next.stage === "approval" || next.stage === "failing" || next.stage === "running") && (
          <a href={`${url}/checks`} target="_blank" rel="noreferrer" className={link}>
            Checks on GitHub <ExternalLink />
          </a>
        )}
        {next.stage === "repo_off" && (
          <Link href={`/repos?q=${encodeURIComponent(repo)}`} className={link}>
            Allow swarms on {repo}
          </Link>
        )}
        {FOLLOWED.has(next.stage) && (
          <Link href="/settings#auto-merge" className={cn(link, "ml-auto", autoMerge && "text-olive")} data-testid="auto-merge-state">
            <Zap /> {autoMerge ? "Auto-merge on" : "Auto-merge off"}
          </Link>
        )}
      </div>
    </Card>
  );
}
