import { accessProfile, cuttingEdgeOnly, discoveryFeed, listSources, radar, searchPlan } from "@elevate/engine";
import { Rss, Satellite } from "lucide-react";
import Link from "next/link";
import { AccessStrip } from "@/components/access-strip";
import { FeedRow, SearchPlan } from "@/components/discovery";
import { ActionButton } from "@/components/repo-toggles";
import { SourcesPanel } from "@/components/sources-panel";
import { TechniqueList } from "@/components/techniques";
import { Empty } from "@/components/ui";
import { getCtx } from "@/lib/server";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function RadarPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const { show } = await searchParams;
  const ctx = await getCtx();
  const [techs, srcs, plan, feed, access, onlyCuttingEdge] = await Promise.all([
    radar(ctx),
    listSources(ctx),
    searchPlan(ctx),
    show === "feed" ? discoveryFeed(ctx, { limit: 150 }) : Promise.resolve([]),
    accessProfile(ctx),
    cuttingEdgeOnly(ctx),
  ]);
  // Things the user can't act on (a replaced model version, a product they don't have) get their own tab.
  const setAside = techs.filter((t) => !t.access.usable);
  const usable = techs.filter((t) => t.access.usable);
  // So does routine upkeep while only cutting-edge ideas are wanted: it's tracked, never recommended.
  const routine = onlyCuttingEdge ? usable.filter((t) => !t.cuttingEdge) : [];
  const frontier = onlyCuttingEdge ? usable.filter((t) => t.cuttingEdge) : usable;
  const legit = frontier.filter((t) => t.legitimacy?.passed);
  const hype = frontier.filter((t) => t.legitimacy && !t.legitimacy.passed);
  const pending = frontier.filter((t) => !t.legitimacy);
  const list = show === "hype" ? hype : show === "pending" ? pending : show === "setaside" ? setAside : show === "routine" ? routine : legit;

  return (
    <div className="mx-auto max-w-5xl px-4 sm:px-8 py-10">
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
      <AccessStrip ecosystems={access.ecosystems} setAside={setAside.length} className="mt-3" />

      <SourcesPanel sources={srcs} demo={ctx.demo} />

      <div className="sticky top-0 z-20 -mx-4 sm:-mx-8 mt-6 tabstrip flex gap-1 border-b border-line bg-bg/80 px-4 sm:px-8 pt-3 backdrop-blur-md" role="tablist" aria-label="Techniques">
        {[
          { k: undefined, label: "Legit", n: legit.length },
          { k: "hype", label: "Hype (filtered)", n: hype.length },
          { k: "pending", label: "Checking", n: pending.length },
          ...(onlyCuttingEdge ? [{ k: "routine", label: "Routine upkeep", n: routine.length }] : []),
          { k: "setaside", label: "Not for your setup", n: setAside.length },
          { k: "feed", label: "Everything pulled in", n: undefined },
        ].map((t) => (
          <Link
            key={t.label}
            scroll={false}
            role="tab"
            aria-selected={show === t.k}
            href={t.k ? `/radar?show=${t.k}` : "/radar"}
            className={cn(
              "-mb-px shrink-0 whitespace-nowrap border-b-2 px-3 pb-2.5 pt-1 text-sm transition-colors",
              show === t.k ? "border-fg text-fg" : "border-transparent text-muted hover:text-fg",
            )}
          >
            {t.label} {t.n != null && <span className="text-xs tabular-nums text-faint">{t.n}</span>}
          </Link>
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
        <TechniqueList
          key={show ?? "legit"}
          techniques={list}
          routineHeld={show === "routine"}
          emptyTitle={show === "setaside" ? "Nothing set aside" : show === "routine" ? "No routine upkeep" : "Nothing here yet"}
          emptyHint={
            show === "setaside"
              ? "Everything on the radar is something you can use."
              : show === "routine"
                ? "Patch releases, deprecations and database tips land here instead of becoming recommendations."
                : undefined
          }
        />
      )}
    </div>
  );
}
