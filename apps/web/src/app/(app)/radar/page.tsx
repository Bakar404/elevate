import { listSources, radar } from "@elevate/engine";
import { ExternalLink, Radar as RadarIcon, Satellite } from "lucide-react";
import { ActionButton } from "@/components/repo-toggles";
import { Badge, Card, Empty, ScoreRing } from "@/components/ui";
import { scoreTone } from "@/lib/tone";
import { getCtx } from "@/lib/server";
import { ago, cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function RadarPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const { show } = await searchParams;
  const ctx = await getCtx();
  const [techs, srcs] = await Promise.all([radar(ctx), listSources(ctx)]);
  const legit = techs.filter((t) => t.legitimacy?.passed);
  const hype = techs.filter((t) => t.legitimacy && !t.legitimacy.passed);
  const pending = techs.filter((t) => !t.legitimacy);
  const list = show === "hype" ? hype : show === "pending" ? pending : legit;

  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Radar</h1>
          <p className="mt-1 text-sm text-muted">Techniques pulled from your sources. Each is scored for legitimacy before it's matched to any repo.</p>
        </div>
        <ActionButton url="/api/radar/sweep" label="Sweep">
          <Satellite /> Sweep now
        </ActionButton>
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        {srcs.map((s) => (
          <Badge key={s.id} tone={s.credibility >= 70 ? "olive" : s.credibility >= 40 ? "sand" : "danger"} title={s.lastError ?? undefined}>
            {s.name} · {s.credibility}
            <span className="text-faint">· {s.lastFetchedAt ? ago(s.lastFetchedAt) : "not fetched"}</span>
          </Badge>
        ))}
      </div>

      <div className="mt-6 flex gap-1 border-b border-line">
        {[
          { k: undefined, label: "Legit", n: legit.length },
          { k: "hype", label: "Hype (filtered)", n: hype.length },
          { k: "pending", label: "Checking", n: pending.length },
        ].map((t) => (
          <a
            key={t.label}
            href={t.k ? `/radar?show=${t.k}` : "/radar"}
            className={cn(
              "-mb-px border-b-2 px-3 pb-2.5 pt-1 text-sm transition-colors",
              show === t.k ? "border-fg text-fg" : "border-transparent text-muted hover:text-fg",
            )}
          >
            {t.label} <span className="text-xs text-faint">{t.n}</span>
          </a>
        ))}
      </div>

      <div className="mt-5 grid gap-3">
        {list.length === 0 && <Empty icon={<RadarIcon />} title="Nothing here yet" />}
        {list.map((t) => (
          <Card key={t.id} className="p-5" data-testid="technique">
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
    </div>
  );
}
