import { discoveryFeed, listSources, radar, searchPlan } from "@elevate/engine";
import { Crosshair, ExternalLink, Radar as RadarIcon, Rss, Satellite } from "lucide-react";
import { FeedRow, RepoChips, SearchPlan } from "@/components/discovery";
import { ActionButton } from "@/components/repo-toggles";
import { Badge, Card, Empty, ScoreRing } from "@/components/ui";
import { scoreTone } from "@/lib/tone";
import { getCtx } from "@/lib/server";
import { ago, cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function RadarPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const { show } = await searchParams;
  const ctx = await getCtx();
  const [techs, srcs, plan, feed] = await Promise.all([
    radar(ctx),
    listSources(ctx),
    searchPlan(ctx),
    show === "feed" ? discoveryFeed(ctx, { limit: 150 }) : Promise.resolve([]),
  ]);
  const legit = techs.filter((t) => t.legitimacy?.passed);
  const hype = techs.filter((t) => t.legitimacy && !t.legitimacy.passed);
  const pending = techs.filter((t) => !t.legitimacy);
  const list = (show === "hype" ? hype : show === "pending" ? pending : legit).sort((a, b) => b.foundFor.length - a.foundFor.length);
  const focusSrcs = srcs.filter((s) => s.url.startsWith("focus://"));
  const feedSrcs = srcs.filter((s) => !s.url.startsWith("focus://"));

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-balance">Radar</h1>
          <p className="mt-1 text-sm text-muted text-pretty">
            Techniques pulled from your sources and from searches built around each repo. Each is scored for legitimacy before it's matched to any repo.
          </p>
        </div>
        <ActionButton url="/api/radar/sweep" label="Sweep">
          <Satellite /> Sweep now
        </ActionButton>
      </div>

      <SearchPlan plan={plan} className="mt-6" />

      <div className="mt-4 grid gap-3 sm:grid-cols-[auto_1fr]">
        <span className="inline-flex items-center gap-1.5 pt-0.5 text-xs text-faint">
          <Crosshair className="size-3.5" aria-hidden /> For your repos
        </span>
        <div className="flex flex-wrap gap-2" data-testid="focus-sources">
          {focusSrcs.length ? (
            focusSrcs.map((s) => <SourceBadge key={s.id} s={s} focus />)
          ) : (
            <span className="text-xs text-faint text-pretty">
              {ctx.demo ? "Demo mode is offline. With GitHub connected, every sweep also searches HN, arXiv and GitHub using the terms above." : "No repo-focused sources yet. They're added on the next sweep."}
            </span>
          )}
        </div>
        <span className="inline-flex items-center gap-1.5 pt-0.5 text-xs text-faint">
          <Rss className="size-3.5" aria-hidden /> Feeds
        </span>
        <div className="flex flex-wrap gap-2">
          {feedSrcs.map((s) => (
            <SourceBadge key={s.id} s={s} />
          ))}
        </div>
      </div>

      <div className="sticky top-0 z-20 -mx-8 mt-6 flex gap-1 border-b border-line bg-bg/80 px-8 pt-3 backdrop-blur-md" role="tablist" aria-label="Techniques">
        {[
          { k: undefined, label: "Legit", n: legit.length },
          { k: "hype", label: "Hype (filtered)", n: hype.length },
          { k: "pending", label: "Checking", n: pending.length },
          { k: "feed", label: "Everything pulled in", n: undefined },
        ].map((t) => (
          <a
            key={t.label}
            role="tab"
            aria-selected={show === t.k}
            href={t.k ? `/radar?show=${t.k}` : "/radar"}
            className={cn(
              "-mb-px border-b-2 px-3 pb-2.5 pt-1 text-sm transition-colors",
              show === t.k ? "border-fg text-fg" : "border-transparent text-muted hover:text-fg",
            )}
          >
            {t.label} {t.n != null && <span className="text-xs tabular-nums text-faint">{t.n}</span>}
          </a>
        ))}
      </div>

      {show === "feed" ? (
        feed.length ? (
          <ul className="mt-5 rounded-2xl border border-line bg-panel/40 px-4" data-testid="feed">
            {feed.map((i) => (
              <FeedRow key={i.id} item={i} />
            ))}
          </ul>
        ) : (
          <div className="mt-5">
            <Empty icon={<Rss />} title="Nothing pulled in yet">
              Sweep to fetch the latest.
            </Empty>
          </div>
        )
      ) : (
      <div className="mt-5 grid gap-3">
        {list.length === 0 && <Empty icon={<RadarIcon />} title="Nothing here yet" />}
        {list.map((t) => (
          <Card key={t.id} className="cv-auto p-5" data-testid="technique">
            <div className="flex gap-4">
              <ScoreRing value={t.legitimacy?.score} tone={scoreTone(t.legitimacy?.score, t.legitimacy?.passed)} label="legitimacy" />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-medium">{t.name}</h3>
                  <Badge>{t.category}</Badge>
                  {t.matches > 0 && <Badge tone="sky">{t.matches} repo match{t.matches === 1 ? "" : "es"}</Badge>}
                </div>
                <p className="mt-1 text-sm text-muted">{t.summary}</p>
                {t.legitimacy?.verdict && <p className="mt-2 text-xs text-faint">{t.legitimacy.verdict}</p>}
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
                  <span className="text-faint">first seen {ago(t.firstSeenAt)}</span>
                </div>
              </div>
            </div>
          </Card>
        ))}
      </div>
      )}
    </div>
  );
}

function SourceBadge({ s, focus }: { s: Awaited<ReturnType<typeof listSources>>[number]; focus?: boolean }) {
  return (
    <Badge
      tone={s.lastError ? "danger" : focus ? "olive" : s.credibility >= 70 ? "olive" : s.credibility >= 40 ? "sand" : "danger"}
      title={s.lastError ?? `credibility ${s.credibility}`}
      className={cn(focus && "border-dashed")}
    >
      {s.name}
      {!focus && <> · {s.credibility}</>}
      <span className="text-faint">· {s.lastFetchedAt ? ago(s.lastFetchedAt) : "not fetched"}</span>
    </Badge>
  );
}
