import { listRecommendations, stats } from "@elevate/engine";
import { Inbox, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { DitherBackground } from "@/components/dither-background";
import { RecCard } from "@/components/rec";
import { Empty, ShimmerText, Stat } from "@/components/ui";
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
  const [s, all] = await Promise.all([stats(ctx), listRecommendations(ctx)]);
  const counts = Object.fromEntries(Object.entries(TABS).map(([k, t]) => [k, all.filter((r) => (t.statuses as readonly string[]).includes(r.status)).length])) as Record<TabKey, number>;
  const rows = all.filter((r) => (TABS[tab].statuses as readonly string[]).includes(r.status));
  const verifying = all.filter((r) => r.status === "candidate").length;

  return (
    <div>
      <section className="relative isolate overflow-hidden border-b border-line">
        <div className="absolute inset-0 -z-10">
          <DitherBackground />
          <div className="absolute inset-0 bg-[linear-gradient(to_bottom,oklch(0.145_0.006_250/0.55),oklch(0.145_0.006_250/0.85)_70%,var(--color-bg))]" />
        </div>
        <div className="mx-auto max-w-5xl px-8 pb-10 pt-14">
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
          <div className="mt-8 grid grid-cols-2 gap-6 rounded-2xl border border-line bg-bg/60 p-5 backdrop-blur-md sm:grid-cols-4">
            <Stat label="Ready" value={s.open} tone="olive" hint="awaiting your call" />
            <Stat label="Repos watched" value={s.repos} hint={`${s.allowedRepos} allow swarms`} />
            <Stat label="Techniques" value={s.techniques} hint={`${s.legit} legit · ${s.hype} hype`} />
            <Stat label="Draft PRs" value={s.prs} tone="sky" hint={`${s.activeSwarms} swarm${s.activeSwarms === 1 ? "" : "s"} running`} />
          </div>
        </div>
      </section>

      <div className="mx-auto max-w-5xl px-8 py-8">
        <div className="mb-5 flex gap-1 border-b border-line" role="tablist">
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
          <Empty icon={<Inbox />} title={tab === "open" ? "Nothing waiting on you" : "Nothing here"}>
            {tab === "open"
              ? "New techniques are checked against your repos as they arrive. Only ones that pass both gates show up here."
              : "Recommendations move here as they progress."}
          </Empty>
        )}
      </div>
    </div>
  );
}
