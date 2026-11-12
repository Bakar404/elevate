import { recentAudit } from "@elevate/engine";
import { ShieldCheck } from "lucide-react";
import { cookies } from "next/headers";
import { MotionSetting } from "@/components/motion-setting";
import { SettingsForm } from "@/components/settings-form";
import { Badge, Card } from "@/components/ui";
import { MOTION_COOKIE, isMotionPref } from "@/lib/prefs";
import { readReceipt } from "@/lib/proof";
import { getCtx } from "@/lib/server";
import { ago } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const ctx = await getCtx();
  const [audit, receipt, jar] = await Promise.all([recentAudit(ctx, 15), Promise.resolve(readReceipt()), cookies()]);
  const motion = jar.get(MOTION_COOKIE)?.value;
  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-8 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-1 text-sm text-muted">Model, GitHub access, how strict the gates are, how far a swarm may go, and motion.</p>

      <SettingsForm />

      <MotionSetting initial={isMotionPref(motion) ? motion : "system"} />

      <Card className="mt-8 p-6" data-testid="proof-card">
        <div className="flex items-start gap-3">
          <ShieldCheck className={receipt?.pass ? "mt-0.5 size-5 text-olive" : "mt-0.5 size-5 text-faint"} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="font-medium">Proved policy kernel</h2>
              {receipt ? <Badge tone={receipt.pass ? "olive" : "danger"}>{receipt.pass ? "receipt: pass" : "receipt: fail"}</Badge> : <Badge>no receipt</Badge>}
            </div>
            <p className="mt-1 text-sm text-muted">
              The rules that decide what reaches your inbox and what a swarm may write are proved in Verus, mutation-checked, and differentially tested against the
              TypeScript that runs here.
              {receipt && (
                <span className="text-faint">
                  {" "}
                  Last run {ago(receipt.at)} at <span className="font-mono">{/^[0-9a-f]{40}$/.test(receipt.gitHead) ? receipt.gitHead.slice(0, 7) : receipt.gitHead}</span>.
                </span>
              )}
            </p>
          </div>
        </div>
        {receipt && (
          <>
            <div className="mt-5 grid gap-2 sm:grid-cols-2">
              {receipt.steps.map((s) => (
                <div key={s.id} className="flex min-w-0 items-start gap-2 rounded-lg border border-line px-3 py-2 text-sm">
                  <span className={s.ok ? "text-olive" : "text-danger"}>{s.ok ? "✓" : "✗"}</span>
                  <div className="min-w-0">
                    <div>{s.name}</div>
                    <div className="truncate text-xs text-faint">{s.detail}</div>
                  </div>
                </div>
              ))}
            </div>
            {receipt.requirements.length > 0 && (
              <details className="mt-4 text-sm">
                <summary className="cursor-pointer text-muted hover:text-fg">{receipt.requirements.length} requirements</summary>
                <div className="mt-3 grid gap-1.5">
                  {receipt.requirements.map((r) => (
                    <div key={r.id} className="grid grid-cols-[2.5rem_1fr] gap-2">
                      <span className="font-mono text-xs text-faint">{r.id}</span>
                      <span className="text-muted">{r.text}</span>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </>
        )}
      </Card>

      <Card className="mt-8 p-6">
        <h2 className="font-medium">Audit log</h2>
        <div className="mt-3 divide-y divide-line text-sm">
          {audit.length === 0 && <div className="py-2 text-faint">Nothing yet.</div>}
          {audit.map((a) => (
            <div key={a.id} className="flex gap-3 py-2">
              <span className="w-24 shrink-0 truncate font-mono text-xs text-faint">{a.actor}</span>
              <span className="min-w-0 truncate font-mono text-xs text-muted">{a.action}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-faint">{a.target}</span>
              <span className="shrink-0 text-xs text-faint">{ago(a.createdAt)}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
