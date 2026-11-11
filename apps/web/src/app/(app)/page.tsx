import { accessProfile, activityGraph, discoveryFeed, listRecommendations, radar, searchPlan, stats } from "@elevate/engine";
import { ArrowRight, Inbox, Radar as RadarIcon, ShieldCheck, Sparkles } from "lucide-react";
import { cookies } from "next/headers";
import Link from "next/link";
import { AccessStrip } from "@/components/access-strip";
import { ActivityGraph } from "@/components/activity-graph";
import { DitherBackground } from "@/components/dither-background";
import { FeedRow, RepoChips, SearchPlan } from "@/components/discovery";
import { Pip } from "@/components/mascot";
import { RecCard } from "@/components/rec";
import { Reveal } from "@/components/scroll";
import { Card, Empty, ScoreRing, ShimmerText, Stat } from "@/components/ui";
import { scoreTone } from "@/lib/tone";
import { DEFAULT_LOGO, isLogoVariant, LOGO_COOKIE } from "@/lib/prefs";
import { getCtx } from "@/lib/server";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

const TABS = {
  open: { label: "Ready for review", statuses: ["open"] },
  flight: { label: "In flight", statuses: ["candidate", "approved", "in_progress"] },
  done: { label: "Done", statuses: ["pr_opened", "failed", "rejected"] },
  filtered: { label: "Filtered out", statuses: ["gated_out"] },
} as const;
type TabKey = keyof typeof TABS;

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab: raw } = await searchParams;
  const tab: TabKey = raw && raw in TABS ? (raw as TabKey) : "open";
  const ctx = await getCtx();
  const [s, all, graph, jar, plan, focused, recent, techs, access] = await Promise.all([
    stats(ctx),
    listRecommendations(ctx),
    activityGraph(ctx),
    cookies(),
    searchPlan(ctx),
    discoveryFeed(ctx, { limit: 8, repoOnly: true, hideHype: true }),
    discoveryFeed(ctx, { limit: 8, hideHype: true }),
    radar(ctx),
    accessProfile(ctx),
  ]);
  // A recommendation the user can no longer act on (its model was replaced, or the product isn't connected) isn't waiting on them.
  const inTab = (r: (typeof all)[number], k: TabKey) =>
    r.blocked && r.status === "open" ? k === "filtered" : (TABS[k].statuses as readonly string[]).includes(r.status);
  const usable = techs.filter((t) => t.access.usable);
  const setAside = techs.length - usable.length;
  const fresh = focused.length ? focused : recent;
  const legit = techs
    .filter((t) => t.legitimacy?.passed && t.access.usable)
    .sort((a, b) => b.foundFor.length - a.foundFor.length || (b.legitimacy?.score ?? 0) - (a.legitimacy?.score ?? 0))
    .slice(0, 4);
  const logo = jar.get(LOGO_COOKIE)?.value;
  const counts = Object.fromEntries((Object.keys(TABS) as TabKey[]).map((k) => [k, all.filter((r) => inTab(r, k)).length])) as Record<TabKey, number>;
  const rows = all.filter((r) => inTab(r, tab));
  const verifying = all.filter((r) => r.status === "candidate").length;

  return (
    <div>
      <section className="relative isolate">
        {/* The background fades out instead of stopping at a hard edge. */}
        <div className="absolute inset-x-0 top-0 -z-10 h-[calc(100%+6rem)] overflow-hidden [mask-image:linear-gradient(to_bottom,#000_55%,transparent)]">
          <DitherBackground />
          <div className="absolute inset-0 bg-[linear-gradient(to_bottom,color-mix(in_oklch,var(--color-bg)_55%,transparent),color-mix(in_oklch,var(--color-bg)_85%,transparent)_70%,var(--color-bg))]" />
        </div>
        <div className="mx-auto max-w-5xl px-4 sm:px-8 pb-10 pt-14">
          <div className="inline-flex items-center gap-2 rounded-full border border-line-strong bg-bg/50 px-3 py-1 text-xs text-muted backdrop-blur">
            <ShieldCheck className="size-3.5 text-olive" />
            Every recommendation passed two gates: the technique is legit, and the change is sound.
          </div>
          <h1 className="mt-5 max-w-2xl text-4xl font-semibold tracking-tight text-balance">
            What's new that would make your repos <span className="text-sand">better</span>.
          </h1>
          {verifying > 0 && (
            <p className="mt-3 text-sm">
              <ShimmerText>
                Verifying {verifying} candidate{verifying === 1 ? "" : "s"}…
              </ShimmerText>
            </p>
          )}
          <div className="mt-8">
            <ActivityGraph data={graph} logo={isLogoVariant(logo) ? logo : DEFAULT_LOGO} />
          </div>
          <div className="mt-4 grid grid-cols-2 gap-6 rounded-2xl border border-line bg-bg/60 p-5 backdrop-blur-md sm:grid-cols-4">
            <Stat label="Ready" value={s.open} tone="olive" hint="awaiting your call" />
            <Stat label="Repos watched" value={s.repos} hint={`${s.allowedRepos} allow swarms`} />
            <Stat label="Techniques" value={s.techniques} hint={`${usable.filter((t) => t.legitimacy?.passed).length} legit · ${usable.filter((t) => t.legitimacy && !t.legitimacy.passed).length} hype${setAside ? ` · ${setAside} set aside` : ""}`} />
            <Stat label="Draft PRs" value={s.prs} tone="sky" hint={`${s.activeSwarms} swarm${s.activeSwarms === 1 ? "" : "s"} running`} />
          </div>
          <SearchPlan plan={plan} className="mt-4" />
          <AccessStrip ecosystems={access.ecosystems} setAside={setAside} className="mt-1" />
        </div>
      </section>

      <div className="mx-auto max-w-5xl px-4 sm:px-8 pb-8" id="inbox">
        <div className="sticky top-0 z-20 -mx-4 sm:-mx-8 mb-5 tabstrip flex gap-1 border-b border-line bg-bg/80 px-4 sm:px-8 pt-3 backdrop-blur-md" role="tablist" aria-label="Recommendations">
          {(Object.keys(TABS) as TabKey[]).map((k) => (
            <Link
              key={k}
              href={k === "open" ? "/" : `/?tab=${k}`}
              role="tab"
              aria-selected={k === tab}
              className={cn(
                "-mb-px flex items-center gap-2 border-b-2 px-3 pb-2.5 pt-1 text-sm transition-colors duration-150",
                k === tab ? "border-fg text-fg" : "border-transparent text-muted hover:text-fg",
              )}
            >
              {TABS[k].label}
              <span className="text-xs tabular-nums text-faint">{counts[k]}</span>
            </Link>
          ))}
        </div>
        {rows.length ? (
          <div className="grid gap-3">
            {rows.map((r, i) => (
              <RecCard key={r.id} r={r} index={i} />
            ))}
          </div>
        ) : (
          <Empty icon={tab === "open" ? <Pip mood="sleepy" size={56} className="size-14!" /> : <Inbox />} title={tab === "open" ? "Nothing waiting on you" : "Nothing here"}>
            {tab === "open"
              ? "New techniques are checked against your repos as they arrive. Only ones that pass both gates show up here."
              : "Recommendations move here as they progress."}
          </Empty>
        )}
      </div>

      <div className="mx-auto grid max-w-5xl gap-10 px-4 sm:px-8 pb-16 lg:grid-cols-[1.4fr_1fr]">
        <Reveal>
          <SectionHead
            icon={<Sparkles />}
            title={focused.length ? "Fresh for your repos" : "Fresh from your sources"}
            hint={focused.length ? "Found by searches built from each repo's stack and domain." : "Repo searches run on the next sweep."}
            href="/radar?show=feed"
          />
          {fresh.length ? (
            <ul className="rounded-2xl border border-line bg-panel/40 px-4" data-testid="fresh">
              {fresh.map((i) => (
                <FeedRow key={i.id} item={i} />
              ))}
            </ul>
          ) : (
            <Empty icon={<Sparkles />} title="Nothing pulled in yet">
              Run a sweep from the Radar to fetch what's new.
            </Empty>
          )}
        </Reveal>
        <Reveal delay={0.08}>
          <SectionHead icon={<RadarIcon />} title="On the radar" hint="Legit techniques, ones found for your repos first." href="/radar" />
          <div className="grid gap-3">
            {legit.length === 0 && <Empty icon={<RadarIcon />} title="No legit techniques yet" />}
            {legit.map((t) => (
              <Card key={t.id} className="flex gap-3 p-4">
                <ScoreRing value={t.legitimacy?.score} size={38} tone={scoreTone(t.legitimacy?.score, t.legitimacy?.passed)} label="legitimacy" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-pretty">{t.name}</p>
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted">{t.summary}</p>
                  <RepoChips repos={t.foundFor} className="mt-2 text-xs" />
                </div>
              </Card>
            ))}
          </div>
        </Reveal>
      </div>
    </div>
  );
}

function SectionHead({ icon, title, hint, href }: { icon: React.ReactNode; title: string; hint: string; href: string }) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <div>
        <h2 className="flex items-center gap-2 text-sm font-medium [&_svg]:size-4 [&_svg]:text-faint">
          {icon}
          {title}
        </h2>
        <p className="mt-0.5 text-xs text-faint">{hint}</p>
      </div>
      <Link href={href} className="inline-flex shrink-0 items-center gap-1 text-xs text-muted hover:text-fg">
        See all <ArrowRight className="size-3" aria-hidden />
      </Link>
    </div>
  );
}