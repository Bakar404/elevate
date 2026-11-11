"use client";

import { Crosshair, Plus, Rss, Settings2, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { ago, cn, send } from "@/lib/utils";
import { Badge, Button, Dialog, Switch } from "./ui";

export type SourceRow = {
  id: string;
  name: string;
  url: string;
  kind: string;
  credibility: number;
  enabled: boolean;
  lastFetchedAt: Date | string | null;
  lastError: string | null;
  builtIn: boolean;
  paused: string | null;
  items: number;
  kept: number;
};

const input = "h-9 w-full rounded-lg border border-line-strong bg-bg/60 px-3 text-sm outline-none transition-colors placeholder:text-faint focus:border-sky/50";
const isFocus = (s: SourceRow) => s.url.startsWith("focus://");

function SourceBadge({ s }: { s: SourceRow }) {
  const focus = isFocus(s);
  const off = !s.enabled || !!s.paused;
  return (
    <Badge
      tone={off ? "neutral" : s.lastError ? "danger" : focus ? "olive" : s.credibility >= 70 ? "olive" : s.credibility >= 40 ? "sand" : "danger"}
      title={s.paused ?? s.lastError ?? (s.enabled ? `credibility ${s.credibility}` : "switched off")}
      className={cn(focus && "border-dashed", off && "opacity-60")}
    >
      {s.name}
      {!focus && !off && <> · {s.credibility}</>}
      <span className="text-faint" suppressHydrationWarning>· {!s.enabled ? "off" : s.paused ? "skipped" : s.lastError ? "failed" : s.lastFetchedAt ? ago(s.lastFetchedAt) : "not fetched"}</span>
    </Badge>
  );
}

/** The Radar's source strip, with a dialog to switch sources on and off, add a feed, or remove one you added. */
export function SourcesPanel({ sources, demo }: { sources: SourceRow[]; demo: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const focus = sources.filter(isFocus);
  const feeds = sources.filter((s) => !isFocus(s));
  const failing = sources.filter((s) => s.enabled && !s.paused && s.lastError).length;

  const run = async (p: Promise<unknown>, ok: string) => {
    try {
      await p;
      toast.success(ok);
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <>
      <div className="mt-4 grid gap-3 sm:grid-cols-[auto_1fr]">
        <span className="inline-flex items-center gap-1.5 pt-0.5 text-xs text-faint">
          <Crosshair className="size-3.5" aria-hidden /> For your repos
        </span>
        <div className="flex flex-wrap gap-2" data-testid="focus-sources">
          {focus.length ? (
            focus.map((s) => <SourceBadge key={s.id} s={s} />)
          ) : (
            <span className="text-xs text-faint text-pretty">
              {demo
                ? "Demo mode is offline. With GitHub connected, every sweep also searches HN, arXiv and GitHub using the terms above."
                : "No repo-focused sources yet. They're added on the next sweep."}
            </span>
          )}
        </div>
        <span className="inline-flex items-center gap-1.5 pt-0.5 text-xs text-faint">
          <Rss className="size-3.5" aria-hidden /> Feeds
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {feeds.map((s) => (
            <SourceBadge key={s.id} s={s} />
          ))}
          <button
            onClick={() => setOpen(true)}
            data-testid="manage-sources"
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-line-strong px-2 py-0.5 text-xs text-muted transition-colors hover:border-sky/50 hover:text-fg [&_svg]:size-3"
          >
            <Settings2 /> Manage sources
            {failing > 0 && <span className="ml-0.5 text-danger">· {failing} failing</span>}
          </button>
        </div>
      </div>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Sources"
        description="Where elevate looks for what's new. Switch off anything that's noise, or add an RSS or Atom feed of your own."
        className="w-[min(94vw,640px)]"
      >
        <ul className="-mx-2 max-h-[46vh] divide-y divide-line overflow-y-auto px-2" data-testid="source-list">
          {sources.map((s) => (
            <li key={s.id} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
                  <span className={cn("truncate", !s.enabled && "text-muted")}>{s.name}</span>
                  {!s.builtIn && <Badge>yours</Badge>}
                  {s.paused && <Badge tone="sand">skipped</Badge>}
                </div>
                <p suppressHydrationWarning className={cn("mt-0.5 truncate text-xs", s.lastError && s.enabled && !s.paused ? "text-danger" : "text-faint")}>
                  {s.paused ??
                    (s.lastError && s.enabled
                      ? `Last fetch failed: ${s.lastError}`
                      : [
                          isFocus(s) ? "searches built from your repos" : `credibility ${s.credibility}`,
                          s.items ? `${s.kept} of ${s.items} items were useful` : "nothing pulled in yet",
                          s.lastFetchedAt ? `fetched ${ago(s.lastFetchedAt)}` : null,
                        ]
                          .filter(Boolean)
                          .join(" · "))}
                </p>
              </div>
              {!s.builtIn && (
                <button
                  aria-label={`Remove ${s.name}`}
                  onClick={() => run(send(`/api/sources/${s.id}`, {}, "DELETE"), `${s.name} removed`)}
                  className="grid size-8 shrink-0 place-items-center rounded-lg text-faint transition-colors hover:bg-danger/10 hover:text-danger"
                >
                  <Trash2 className="size-4" />
                </button>
              )}
              <Switch
                checked={s.enabled}
                aria-label={`${s.enabled ? "Switch off" : "Switch on"} ${s.name}`}
                onCheckedChange={(enabled) => run(send(`/api/sources/${s.id}`, { enabled }, "PATCH"), `${s.name} ${enabled ? "on" : "off"}`)}
              />
            </li>
          ))}
        </ul>
        <form
          className="mt-4 grid gap-2 border-t border-line pt-4 sm:grid-cols-[1fr_1.6fr_auto]"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try {
              await send("/api/sources", { name, url });
              toast.success(`${name} added. It's fetched on the next sweep.`);
              setName("");
              setUrl("");
              router.refresh();
            } catch (err) {
              toast.error((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" aria-label="Feed name" required maxLength={80} />
          <input className={input} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/feed.xml" aria-label="Feed URL" type="url" required />
          <Button type="submit" size="md" disabled={busy || !name.trim() || !url.trim()}>
            <Plus /> Add feed
          </Button>
        </form>
      </Dialog>
    </>
  );
}
