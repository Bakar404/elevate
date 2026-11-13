"use client";

import { Ban, ExternalLink, History, Radar as RadarIcon, Search, Wrench, X } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { RepoChips } from "@/components/discovery";
import { Badge, Card, Empty, ScoreRing } from "@/components/ui";
import { scoreTone } from "@/lib/tone";
import { ago, cn } from "@/lib/utils";

export type TechniqueRow = {
  id: string;
  name: string;
  summary: string;
  category: string;
  legitimacy: { passed: boolean; score: number; verdict: string } | null;
  firstSeenAt: Date | string;
  items: { url: string; source: string }[];
  foundFor: string[];
  matches: number;
  access: { requires: { id: string; label: string }[]; models: string[]; usable: boolean; kind: string | null; reason: string | null };
  /** False for routine upkeep (patch releases, deprecations, database tips) rather than a new technique. */
  cuttingEdge: boolean;
};

const SORTS = {
  relevant: "Most relevant",
  newest: "Newest",
  score: "Highest score",
} as const;
type Sort = keyof typeof SORTS;

/** Why a technique was set aside, in two words. */
export function AccessBadge({ access }: { access: Pick<TechniqueRow["access"], "kind" | "reason"> }) {
  if (!access.kind) return null;
  const label = access.kind === "superseded" ? "outdated" : access.kind === "not-on-plan" ? "not on your plan" : "not connected";
  return (
    <Badge tone="sand" title={access.reason ?? undefined}>
      {access.kind === "superseded" ? <History /> : <Ban />}
      {label}
    </Badge>
  );
}

/**
 * The Radar's technique cards with a search box, category chips and a sort, all filtered in the browser.
 * `routineHeld` says routine upkeep in the list is kept out of recommendations (Settings → Cutting-edge only).
 */
export function TechniqueList({
  techniques,
  emptyTitle = "Nothing here yet",
  emptyHint,
  routineHeld = false,
}: {
  techniques: TechniqueRow[];
  emptyTitle?: string;
  emptyHint?: string;
  routineHeld?: boolean;
}) {
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("relevant");

  const categories = useMemo(() => {
    const n = new Map<string, number>();
    for (const t of techniques) n.set(t.category, (n.get(t.category) ?? 0) + 1);
    return [...n.entries()].sort((a, b) => b[1] - a[1]);
  }, [techniques]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = techniques.filter(
      (t) =>
        (!category || t.category === category) &&
        (!needle || [t.name, t.summary, t.category, ...t.foundFor, ...t.items.map((i) => i.source), ...t.access.models].some((s) => s.toLowerCase().includes(needle))),
    );
    const time = (t: TechniqueRow) => new Date(t.firstSeenAt).getTime();
    if (sort === "newest") return [...rows].sort((a, b) => time(b) - time(a));
    if (sort === "score") return [...rows].sort((a, b) => (b.legitimacy?.score ?? -1) - (a.legitimacy?.score ?? -1));
    return [...rows].sort((a, b) => b.foundFor.length - a.foundFor.length || b.matches - a.matches || (b.legitimacy?.score ?? 0) - (a.legitimacy?.score ?? 0));
  }, [techniques, q, category, sort]);

  if (!techniques.length) {
    return (
      <div className="mt-5">
        <Empty icon={<RadarIcon />} title={emptyTitle}>
          {emptyHint}
        </Empty>
      </div>
    );
  }

  return (
    <div className="mt-5">
      {techniques.length > 3 && (
        <div className="mb-4 grid gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-0 flex-1 basis-56">
              <span className="sr-only">Filter techniques</span>
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Filter by name, source, repo or model"
                data-testid="technique-filter"
                className="h-9 w-full rounded-lg border border-line-strong bg-bg/60 pl-9 pr-9 text-sm outline-none transition-colors placeholder:text-faint focus:border-sky/50"
              />
              {q && (
                <button
                  onClick={() => setQ("")}
                  aria-label="Clear filter"
                  className="absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-faint hover:bg-ink/5 hover:text-fg"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </label>
            <label className="flex items-center gap-2 text-xs text-faint">
              Sort
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as Sort)}
                className="h-9 rounded-lg border border-line-strong bg-bg/60 px-2 text-sm text-fg outline-none focus:border-sky/50"
              >
                {Object.entries(SORTS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {categories.length > 1 && (
            <div className="rail flex gap-1.5 overflow-x-auto" role="group" aria-label="Category">
              {categories.map(([c, n]) => (
                <button
                  key={c}
                  aria-pressed={category === c}
                  onClick={() => setCategory(category === c ? null : c)}
                  className={cn(
                    "shrink-0 rounded-full border px-2.5 py-1 text-xs transition-colors",
                    category === c ? "border-sky/50 bg-sky/10 text-fg" : "border-line text-muted hover:border-line-strong hover:text-fg",
                  )}
                >
                  {c} <span className="tabular-nums text-faint">{n}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="grid gap-3">
        {shown.length === 0 && (
          <Empty icon={<Search />} title="No technique matches that filter">
            <button
              className="underline decoration-line-strong underline-offset-4 hover:text-fg"
              onClick={() => {
                setQ("");
                setCategory(null);
              }}
            >
              Clear the filter
            </button>
          </Empty>
        )}
        {shown.map((t) => (
          <Card key={t.id} className="cv-auto p-5" data-testid="technique">
            <div className="flex gap-4">
              {t.access.usable && (t.legitimacy || t.cuttingEdge) ? (
                <ScoreRing value={t.legitimacy?.score} tone={scoreTone(t.legitimacy?.score, t.legitimacy?.passed)} label="legitimacy" />
              ) : (
                <div className="grid size-11 shrink-0 place-items-center rounded-full border border-dashed border-line-strong text-faint" aria-hidden>
                  {!t.access.usable ? t.access.kind === "superseded" ? <History className="size-4" /> : <Ban className="size-4" /> : <Wrench className="size-4" />}
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-medium">{t.name}</h3>
                  <Badge>{t.category}</Badge>
                  {!t.cuttingEdge && (
                    <Badge title="Routine upkeep rather than a new technique">
                      <Wrench /> routine
                    </Badge>
                  )}
                  {t.access.requires.map((r) => (
                    <Badge key={r.id} tone={t.access.usable ? "sky" : "neutral"} title={`Only useful with ${r.label}`}>
                      {r.label}
                    </Badge>
                  ))}
                  <AccessBadge access={t.access} />
                  {t.matches > 0 && (
                    <Badge tone="sky">
                      {t.matches} repo match{t.matches === 1 ? "" : "es"}
                    </Badge>
                  )}
                </div>
                <p className="mt-1 text-sm text-muted">{t.summary}</p>
                {t.access.reason ? (
                  <p className="mt-2 text-xs text-sand" data-testid="access-reason">
                    {t.access.reason}.
                  </p>
                ) : routineHeld && !t.cuttingEdge ? (
                  <p className="mt-2 text-xs text-faint" data-testid="routine-reason">
                    Routine upkeep, so it isn&apos;t turned into recommendations while you want cutting-edge ideas only.{" "}
                    <Link href="/settings#recommendations" className="underline decoration-line-strong underline-offset-4 hover:text-fg">
                      Change that
                    </Link>
                  </p>
                ) : (
                  t.legitimacy?.verdict && <p className="mt-2 text-xs text-faint">{t.legitimacy.verdict}</p>
                )}
                {t.foundFor.length > 0 && (
                  <p className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted" data-testid="found-for">
                    Found searching for <RepoChips repos={t.foundFor} max={4} />
                  </p>
                )}
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  {t.items.map((i) => (
                    <a key={i.url} href={i.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-faint hover:text-fg">
                      {i.source} <ExternalLink className="size-3" />
                    </a>
                  ))}
                  {/* A relative time can tick over between the server render and hydration. */}
                  <span className="text-faint" suppressHydrationWarning>
                    first seen {ago(t.firstSeenAt)}
                  </span>
                </div>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
