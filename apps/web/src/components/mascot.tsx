"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "@/lib/motion";
import { PIP_COOKIE, PIP_EVENT, setPrefCookie } from "@/lib/prefs";
import { cn } from "@/lib/utils";

export type PipMood = "sleepy" | "alert" | "working";

export function pipMood(counts: { open: number; activeSwarms: number }): PipMood {
  return counts.activeSwarms > 0 ? "working" : counts.open > 0 ? "alert" : "sleepy";
}

/**
 * Pip, elevate's lookout: a small radar critter. It dozes when nothing is waiting, perks up when a
 * recommendation is ready and gets busy while a swarm runs. Its eyes follow the pointer. All motion
 * is CSS and holds still when motion is reduced (Settings → Motion, or the system; see globals.css).
 */
export function Pip({ mood, size = 44, className }: { mood: PipMood; size?: number; className?: string }) {
  const ref = useRef<SVGSVGElement>(null);
  const reduce = usePrefersReducedMotion();

  useEffect(() => {
    if (mood === "sleepy" || reduce || !matchMedia("(pointer: fine)").matches) return;
    let frame = 0;
    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const el = ref.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const dx = e.clientX - (r.left + r.width / 2);
        const dy = e.clientY - (r.top + r.height / 2);
        const d = Math.hypot(dx, dy) || 1;
        const reach = Math.min(1, d / 160) * 1.6;
        el.style.setProperty("--look-x", `${((dx / d) * reach).toFixed(2)}px`);
        el.style.setProperty("--look-y", `${((dy / d) * reach).toFixed(2)}px`);
      });
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(frame);
    };
  }, [mood, reduce]);

  const signal = mood === "alert" ? "var(--color-olive)" : mood === "working" ? "var(--color-sky)" : "var(--color-faint)";
  return (
    <svg ref={ref} viewBox="0 0 48 48" width={size} height={size} className={cn("pip", className)} data-mood={mood} aria-hidden>
      <ellipse cx="24" cy="44.5" rx="11" ry="1.6" className="pip-shadow" />
      <g className="pip-body">
        {/* Antenna with a signal light. */}
        <g className="pip-antenna">
          <path d="M24 13V6.5" stroke="var(--color-muted)" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="24" cy="5" r="4" fill="none" stroke={signal} strokeWidth="1" className="pip-ping" />
          <circle cx="24" cy="5" r="2.2" fill={signal} className="pip-light" />
        </g>
        {/* Feet first, so the body overlaps them. */}
        <rect x="14" y="38.5" width="7" height="5" rx="2.5" fill="var(--pip-shade)" />
        <rect x="27" y="38.5" width="7" height="5" rx="2.5" fill="var(--pip-shade)" />
        <rect x="8" y="12" width="32" height="29" rx="12" fill="var(--pip-fur)" />
        <path d="M13 31c2 5 6 7.5 11 7.5s9-2.500 11-7.500" fill="none" stroke="var(--pip-shade)" strokeWidth="1.4" strokeLinecap="round" opacity="0.55" />
        {mood === "sleepy" ? (
          <g fill="none" stroke="var(--pip-ink)" strokeWidth="1.8" strokeLinecap="round">
            <path d="M15 25.500q3 2.400 6 0" />
            <path d="M27 25.500q3 2.400 6 0" />
          </g>
        ) : (
          <g className="pip-eyes" fill="var(--pip-ink)">
            <g className="pip-look">
              <ellipse cx="18" cy="24.5" rx="2.9" ry={mood === "alert" ? 3.9 : 3.3} />
              <ellipse cx="30" cy="24.5" rx="2.9" ry={mood === "alert" ? 3.9 : 3.3} />
              <circle cx="19" cy="23.2" r="0.9" fill="var(--pip-fur)" />
              <circle cx="31" cy="23.2" r="0.9" fill="var(--pip-fur)" />
            </g>
          </g>
        )}
        <circle cx="13.500" cy="30" r="2" fill="var(--color-danger)" opacity="0.28" />
        <circle cx="34.500" cy="30" r="2" fill="var(--color-danger)" opacity="0.28" />
        {mood === "alert" ? (
          <path d="M21 30.500q3 3.600 6 0z" fill="var(--pip-ink)" />
        ) : (
          <path d={mood === "working" ? "M21.500 31.500h5" : "M22 31q2 1.400 4 0"} fill="none" stroke="var(--pip-ink)" strokeWidth="1.5" strokeLinecap="round" />
        )}
      </g>
      {mood === "sleepy" && (
        <g className="pip-zzz" fill="var(--color-faint)" fontSize="7" fontWeight="700" fontFamily="var(--font-sans)">
          <text x="36" y="13">z</text>
          <text x="40.500" y="7.500" fontSize="5.500">
            z
          </text>
        </g>
      )}
    </svg>
  );
}

const LINES: Record<PipMood, (c: { open: number; activeSwarms: number }) => { text: string; href: string; cta: string }> = {
  alert: (c) => ({ text: `${c.open} recommendation${c.open === 1 ? " is" : "s are"} ready for you.`, href: "/#inbox", cta: "Open the inbox" }),
  working: (c) => ({ text: `${c.activeSwarms} swarm${c.activeSwarms === 1 ? " is" : "s are"} at work. I'm keeping watch.`, href: "/swarms", cta: "See the swarms" }),
  sleepy: () => ({ text: "All quiet. I'm watching your sources and will wake up when something fits your repos.", href: "/radar", cta: "Look at the radar" }),
};

/** Pip in the sidebar: click for a one-line status. Hidden with the bubble's "Hide Pip" or from ⌘K. */
export function PipCompanion({ counts, compact, initialHidden = false }: { counts: { open: number; activeSwarms: number }; compact?: boolean; initialHidden?: boolean }) {
  const [hidden, setHidden] = useState(initialHidden);
  const [open, setOpen] = useState(false);
  const [hop, setHop] = useState(0);
  const mood = pipMood(counts);
  const line = LINES[mood](counts);

  useEffect(() => {
    const toggle = () =>
      setHidden((h) => {
        setPrefCookie(PIP_COOKIE, h ? "on" : "off");
        return !h;
      });
    window.addEventListener(PIP_EVENT, toggle);
    return () => window.removeEventListener(PIP_EVENT, toggle);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  if (hidden) return null;
  return (
    <div className="relative" data-testid="pip">
      {open && (
        <div
          role="status"
          className="popup absolute bottom-full left-0 z-30 mb-2 w-52 rounded-xl border border-line-strong bg-raised p-3 text-xs shadow-xl"
          data-testid="pip-bubble"
        >
          <p className="text-pretty text-fg">{line.text}</p>
          <div className="mt-2 flex items-center justify-between gap-2">
            <Link href={line.href} onClick={() => setOpen(false)} className="text-sky underline decoration-sky/40 underline-offset-4 hover:decoration-sky">
              {line.cta}
            </Link>
            <button
              className="text-faint hover:text-fg"
              onClick={() => {
                setOpen(false);
                window.dispatchEvent(new Event(PIP_EVENT));
              }}
            >
              Hide Pip
            </button>
          </div>
        </div>
      )}
      <button
        type="button"
        aria-label={`Pip, your lookout: ${line.text}`}
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          setHop((h) => h + 1);
        }}
        className={cn(
          "group flex w-full items-center gap-2.5 rounded-lg px-1.5 py-1 text-left transition-colors hover:bg-ink/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky",
          compact && "justify-center px-0",
        )}
      >
        {/* Re-keyed on click so the hop replays. */}
        <span key={hop} className={cn("shrink-0", hop > 0 && "pip-hop")}>
          <Pip mood={mood} size={compact ? 34 : 40} />
        </span>
        {!compact && (
          <span className="min-w-0 whitespace-nowrap">
            <span className="block text-xs font-medium text-fg">Pip</span>
            <span className="block truncate text-[11px] text-faint">{mood === "alert" ? `${counts.open} ready for you` : mood === "working" ? "watching the swarms" : "all quiet"}</span>
          </span>
        )}
      </button>
    </div>
  );
}
