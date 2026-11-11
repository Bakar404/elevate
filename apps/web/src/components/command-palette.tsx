"use client";

import { Command } from "cmdk";
import { ArrowRight, FolderGit2, PanelLeft, Palette, Radar, RefreshCw, Satellite, SunMoon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { SIDEBAR_EVENT } from "@/lib/prefs";
import { send } from "@/lib/utils";
import { NAV } from "./sidebar";
import { THEME_EVENT } from "./theme";

type Rec = { id: string; title: string; repo: string; status: string };
type Repo = { id: string; fullName: string; language: string | null; topics: string[]; profile: { stack: string[]; domains: string[] } | null };
type Tech = { id: string; name: string; category: string; legitimacy: { passed: boolean } | null; foundFor: string[] };

/** ⌘K. Opens instantly: keyboard-triggered UI should not animate in. */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [recs, setRecs] = useState<Rec[]>([]);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [techs, setTechs] = useState<Tech[]>([]);
  const router = useRouter();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("elevate:palette", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("elevate:palette", onOpen);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const load = <T,>(url: string, set: (rows: T[]) => void) =>
      fetch(url)
        .then((r) => r.json())
        .then((rows: T[]) => set(Array.isArray(rows) ? rows : []))
        .catch(() => {});
    load("/api/recommendations", setRecs);
    load("/api/repos", setRepos);
    load("/api/radar", setTechs);
  }, [open]);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };
  const action = (label: string, url: string) => {
    setOpen(false);
    toast.promise(send<{ queued: boolean; message?: string }>(url), {
      loading: `${label}…`,
      success: (r) => r.message ?? `${label} queued`,
      error: (e: Error) => e.message,
    });
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      overlayClassName="fixed inset-0 z-50 bg-black/50"
      contentClassName="fixed left-1/2 top-[18vh] z-50 w-[min(92vw,600px)] -translate-x-1/2 overflow-hidden rounded-xl border border-line-strong bg-panel shadow-2xl"
    >
      <Command.Input placeholder="Search repos by stack or domain, techniques, recommendations…" className="h-12 w-full border-b border-line bg-transparent px-4 text-[15px] outline-none placeholder:text-faint" />
      <Command.List className="max-h-[50vh] overflow-y-auto p-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-faint">
        <Command.Empty className="px-3 py-6 text-center text-sm text-faint">Nothing matches.</Command.Empty>
        <Command.Group heading="Go to">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Item key={href} onSelect={() => go(href)}>
              <Icon /> {label}
            </Item>
          ))}
        </Command.Group>
        <Command.Group heading="Actions">
          <Item onSelect={() => action("Radar sweep", "/api/radar/sweep")}>
            <Satellite /> Sweep sources now
          </Item>
          <Item onSelect={() => action("Repo sync", "/api/repos/sync")}>
            <RefreshCw /> Sync GitHub repos
          </Item>
          <Item
            onSelect={() => {
              setOpen(false);
              window.dispatchEvent(new Event(SIDEBAR_EVENT));
            }}
          >
            <PanelLeft /> Toggle sidebar
            <kbd className="ml-auto font-mono text-[11px] text-faint">⌘B</kbd>
          </Item>
          <Item
            value="Toggle theme light dark mode"
            onSelect={() => {
              setOpen(false);
              window.dispatchEvent(new Event(THEME_EVENT));
            }}
          >
            <SunMoon /> Toggle light / dark theme
          </Item>
          <Item onSelect={() => go("/brand")}>
            <Palette /> Logo drafts
          </Item>
        </Command.Group>
        {recs.length > 0 && (
          <Command.Group heading="Recommendations">
            {recs.slice(0, 30).map((r) => (
              <Item key={r.id} value={`${r.title} ${r.repo} ${r.id}`} onSelect={() => go(`/r/${r.id}`)}>
                <ArrowRight />
                <span className="truncate">{r.title}</span>
                <span className="ml-auto shrink-0 text-xs text-faint">{r.repo}</span>
              </Item>
            ))}
          </Command.Group>
        )}
        {repos.length > 0 && (
          <Command.Group heading="Repos">
            {repos.map((r) => (
              <Item
                key={r.id}
                value={`repo ${r.fullName}`}
                keywords={[r.language ?? "", ...r.topics, ...(r.profile?.stack ?? []), ...(r.profile?.domains ?? [])].filter(Boolean)}
                onSelect={() => go(`/repos?q=${encodeURIComponent(r.fullName.split("/").at(-1) ?? r.fullName)}`)}
              >
                <FolderGit2 />
                <span className="truncate font-mono text-[13px]">{r.fullName}</span>
                <span className="ml-auto shrink-0 truncate text-xs text-faint">{(r.profile?.stack ?? [r.language]).filter(Boolean).slice(0, 3).join(" · ")}</span>
              </Item>
            ))}
          </Command.Group>
        )}
        {techs.length > 0 && (
          <Command.Group heading="Techniques">
            {techs.map((t) => (
              <Item
                key={t.id}
                value={`technique ${t.name} ${t.id}`}
                keywords={[t.category, ...t.foundFor]}
                onSelect={() => go(t.legitimacy?.passed ? "/radar" : t.legitimacy ? "/radar?show=hype" : "/radar?show=pending")}
              >
                <Radar />
                <span className="truncate">{t.name}</span>
                <span className="ml-auto shrink-0 text-xs text-faint">
                  {t.foundFor.length ? `for ${t.foundFor.map((n) => n.split("/").at(-1)).slice(0, 2).join(", ")}` : t.legitimacy?.passed ? "legit" : t.legitimacy ? "hype" : "checking"}
                </span>
              </Item>
            ))}
          </Command.Group>
        )}
      </Command.List>
    </Command.Dialog>
  );
}

function Item({ children, ...props }: React.ComponentProps<typeof Command.Item>) {
  return (
    <Command.Item
      className="flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2 text-sm text-muted data-[selected=true]:bg-ink/[0.06] data-[selected=true]:text-fg [&_svg]:size-4 [&_svg]:shrink-0"
      {...props}
    >
      {children}
    </Command.Item>
  );
}
