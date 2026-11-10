import type { GateResult } from "@elevate/db";
import { ExternalLink } from "lucide-react";
import { scoreTone } from "@/lib/tone";
import { Badge, Card, ScoreRing } from "./ui";

export function GateCard({ id, title, question, gate }: { id: string; title: string; question: string; gate: GateResult | null | undefined }) {
  return (
    <Card className="p-5" data-testid={`gate-${id}`}>
      <div className="flex items-start gap-4">
        <ScoreRing value={gate?.score} tone={scoreTone(gate?.score, gate?.passed)} size={52} label={title} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="font-medium">{title}</h3>
            {gate ? <Badge tone={gate.passed ? "olive" : "danger"}>{gate.passed ? "passed" : "failed"}</Badge> : <Badge>pending</Badge>}
          </div>
          <p className="text-xs text-faint">{question}</p>
          {gate?.verdict && <p className="mt-2 text-sm text-muted">{gate.verdict}</p>}
        </div>
      </div>
      {gate && gate.reasons.length > 0 && (
        <ul className="mt-4 space-y-1.5 border-t border-line pt-4 text-sm text-muted">
          {gate.reasons.map((r, i) => (
            <li key={i} className="flex gap-2">
              <span className="mt-2 size-1 shrink-0 rounded-full bg-faint" />
              {r}
            </li>
          ))}
        </ul>
      )}
      {gate && gate.evidence.length > 0 && (
        <dl className="mt-4 grid gap-2 border-t border-line pt-4 text-sm">
          {gate.evidence.map((e, i) => (
            <div key={i} className="grid grid-cols-[minmax(0,10rem)_1fr] gap-3">
              <dt className="truncate text-faint">{e.label}</dt>
              <dd className="min-w-0 text-muted">
                {e.url ? (
                  <a href={e.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-fg">
                    {e.detail} <ExternalLink className="size-3" />
                  </a>
                ) : (
                  e.detail
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}
