import { listRepos } from "@elevate/engine";
import { FolderGit2, Lock, RefreshCw, Star } from "lucide-react";
import Link from "next/link";
import { ActionButton, RepoToggles } from "@/components/repo-toggles";
import { Badge, Empty, SpotlightCard } from "@/components/ui";
import { getCtx } from "@/lib/server";
import { ago } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function ReposPage() {
  const ctx = await getCtx();
  const rows = await listRepos(ctx);
  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Repos</h1>
          <p className="mt-1 text-sm text-muted">Each repo is profiled (stack, modules, tests) so new techniques can be matched to it. Swarms only write where you allow them.</p>
        </div>
        <ActionButton url="/api/repos/sync" label="Repo sync">
          <RefreshCw /> Sync
        </ActionButton>
      </div>
      <div className="mt-8 grid gap-3">
        {rows.length === 0 && (
          <Empty icon={<FolderGit2 />} title="No repos yet">
            Connect GitHub in Settings, then sync.
          </Empty>
        )}
        {rows.map((r) => (
          <SpotlightCard key={r.id} className="p-5" data-testid="repo">
            <div className="flex flex-wrap items-start gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <a href={r.htmlUrl} target="_blank" rel="noreferrer" className="font-mono text-sm font-medium hover:text-sky">
                    {r.fullName}
                  </a>
                  {r.isPrivate && <Lock className="size-3.5 text-faint" />}
                  {r.language && <Badge>{r.language}</Badge>}
                  <span className="inline-flex items-center gap-1 text-xs text-faint">
                    <Star className="size-3" /> {r.stars}
                  </span>
                </div>
                <p className="mt-1 text-sm text-muted">{r.profile?.summary ?? r.description ?? "Not profiled yet."}</p>
                {r.profile && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {r.profile.stack.slice(0, 6).map((s) => (
                      <Badge key={s} tone="sky">
                        {s}
                      </Badge>
                    ))}
                  </div>
                )}
                <div className="mt-3 flex gap-4 text-xs text-faint">
                  <span>pushed {ago(r.pushedAt)}</span>
                  <span>profiled {ago(r.profiledAt)}</span>
                  {r.open > 0 && (
                    <Link href="/" className="text-olive hover:underline">
                      {r.open} ready
                    </Link>
                  )}
                  {r.prs > 0 && <span className="text-sky">{r.prs} draft PR{r.prs === 1 ? "" : "s"}</span>}
                </div>
              </div>
              <RepoToggles id={r.id} name={r.fullName} watch={r.watch} allowSwarm={r.allowSwarm} />
            </div>
          </SpotlightCard>
        ))}
      </div>
    </div>
  );
}
