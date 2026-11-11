"use client";

import { Search, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { cn } from "@/lib/utils";

const REPO_FILTERS = [
  { k: "all", label: "All" },
  { k: "watched", label: "Watched" },
  { k: "swarm", label: "Swarms allowed" },
  { k: "recs", label: "Has recommendations" },
  { k: "unprofiled", label: "Not profiled" },
] as const;

/** Search box + filter chips whose state lives in the URL (?q=&f=), so it survives reloads and can be shared. */
export function RepoSearch({ counts, shown }: { counts: Record<string, number>; shown: number }) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [pending, start] = useTransition();
  const f = params.get("f") ?? "all";
  const input = useRef<HTMLInputElement>(null);

  const push = (next: { q?: string; f?: string }) => {
    const sp = new URLSearchParams(params);
    for (const [k, v] of Object.entries(next)) v && v !== "all" ? sp.set(k, v) : sp.delete(k);
    start(() => router.replace(sp.size ? `${path}?${sp}` : path, { scroll: false }));
  };

  const urlQ = params.get("q") ?? "";
  useEffect(() => {
    if (document.activeElement !== input.current) setQ(urlQ);
  }, [urlQ]);

  useEffect(() => {
    if (q === (params.get("q") ?? "")) return;
    const t = setTimeout(() => push({ q: q.trim() }), 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "/" && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  return (
    <div className="sticky top-0 z-20 -mx-4 sm:-mx-8 border-b border-line bg-bg/80 px-4 sm:px-8 py-3 backdrop-blur-md">
      <div className="flex items-center gap-3">
        <label className="relative flex-1">
          <span className="sr-only">Search repos</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" aria-hidden />
          <input
            ref={input}
            type="search"
            name="q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, stack, domain, topic…  ( / )"
            autoComplete="off"
            spellCheck={false}
            data-testid="repo-search"
            className="h-9 w-full rounded-lg pointer-coarse:h-11 border border-line bg-panel/70 pl-9 pr-9 text-sm placeholder:text-faint focus-visible:border-line-strong"
          />
          {q && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQ("")}
              className="absolute right-2 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded text-faint pointer-coarse:size-9 hover:text-fg"
            >
              <X className="size-3.5" />
            </button>
          )}
        </label>
        <span className={cn("shrink-0 text-xs tabular-nums text-faint transition-opacity", pending && "opacity-50")} aria-live="polite">
          {shown} shown
        </span>
      </div>
      <div className="rail mt-2 flex gap-1.5 overflow-x-auto" role="tablist" aria-label="Filter repos">
        {REPO_FILTERS.map((x) => (
          <button
            key={x.k}
            type="button"
            role="tab"
            aria-selected={f === x.k}
            onClick={() => push({ f: x.k })}
            className={cn(
              "shrink-0 rounded-full border px-2.5 py-1 text-xs pointer-coarse:px-3.5 pointer-coarse:py-2 transition-colors duration-150",
              f === x.k ? "border-line-strong bg-raised text-fg" : "border-line text-muted hover:text-fg",
            )}
          >
            {x.label} <span className="tabular-nums text-faint">{counts[x.k] ?? 0}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
