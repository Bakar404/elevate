import type { FeedItem } from "@elevate/engine";
import { ArrowUpRight, Crosshair, Search } from "lucide-react";
import { Badge } from "@/components/ui";
import { ago, cn } from "@/lib/utils";

const STATUS: Record<string, { label: string; tone: "olive" | "sand" | "sky" | "neutral" }> = {
  new: { label: "queued", tone: "neutral" },
  irrelevant: { label: "not relevant", tone: "neutral" },
  triaged: { label: "relevant", tone: "sky" },
  error: { label: "error", tone: "neutral" },
};

function shortRepo(fullName: string) {
  return fullName.split("/").at(-1) ?? fullName;
}

export function RepoChips({ repos, max = 3, className }: { repos: string[]; max?: number; className?: string }) {
  if (!repos.length) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)}>
      <Crosshair className="size-3 text-olive" aria-hidden />
      {repos.slice(0, max).map((r) => (
        <span key={r} title={r} className="rounded-md bg-olive/10 px-1.5 py-0.5 font-mono text-[11px] text-olive">
          {shortRepo(r)}
        </span>
      ))}
      {repos.length > max && <span className="text-[11px] text-faint">+{repos.length - max}</span>}
    </span>
  );
}

export function FeedRow({ item }: { item: FeedItem }) {
  const s = item.technique
    ? { label: item.legit === false ? "hype" : item.legit ? "legit" : "checking", tone: item.legit === false ? ("neutral" as const) : item.legit ? ("olive" as const) : ("sand" as const) }
    : (STATUS[item.status] ?? STATUS.new!);
  return (
    <li className="cv-auto group flex items-start gap-3 border-b border-line px-1 py-3 last:border-0" data-testid="feed-item">
      <div className="min-w-0 flex-1">
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex max-w-full items-start gap-1 text-sm text-fg decoration-line-strong underline-offset-4 hover:underline"
        >
          <span className="min-w-0 break-words">{item.title}</span>
          <ArrowUpRight className="mt-0.5 size-3.5 shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" aria-hidden />
        </a>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-faint">
          <span>{item.source}</span>
          {item.points != null && <span className="tabular-nums">{item.points} pts</span>}
          {item.stars != null && <span className="tabular-nums">★ {item.stars}</span>}
          <span>{ago(item.createdAt)}</span>
          {item.technique && <span className="text-muted">→ {item.technique}</span>}
          <RepoChips repos={item.repos} />
        </div>
      </div>
      <Badge tone={s.tone} className="shrink-0">
        {s.label}
      </Badge>
    </li>
  );
}

export function SearchPlan({ plan, className }: { plan: { term: string; kind: string; repos: string[] }[]; className?: string }) {
  if (!plan.length) return null;
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-faint">
        <Search className="size-3.5" aria-hidden /> Searching for
      </span>
      <div className="rail flex min-w-0 gap-1.5 overflow-x-auto py-1" data-testid="search-plan">
        {plan.map((q) => (
          <span
            key={q.term}
            title={`${q.kind} term for ${q.repos.join(", ")}`}
            className="shrink-0 rounded-full border border-line bg-panel/70 px-2.5 py-1 text-xs text-muted"
          >
            {q.term}
            <span className="ml-1.5 text-faint">· {q.repos.map(shortRepo).slice(0, 2).join(", ")}
              {q.repos.length > 2 ? ` +${q.repos.length - 2}` : ""}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
