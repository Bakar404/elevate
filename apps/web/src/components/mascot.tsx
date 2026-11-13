"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { toast } from "sonner";
import { useModKey } from "@/lib/mod-key";
import { usePrefersReducedMotion } from "@/lib/motion";
import { PIP_COOKIE, PIP_EVENT, setPrefCookie } from "@/lib/prefs";
import { cn } from "@/lib/utils";

export type PipMood = "sleepy" | "alert" | "working";
type Counts = { open: number; activeSwarms: number };

export function pipMood(counts: Counts): PipMood {
  return counts.activeSwarms > 0 ? "working" : counts.open > 0 ? "alert" : "sleepy";
}

/** One-off moves played over the mood's idle loop. Each is CSS keyed off data-act (globals.css); durations match it. */
const ACT_MS = { look: 1600, hop: 700, wave: 1300, scan: 1800, spin: 900, cheer: 1500, startle: 1000, surprise: 1000, nod: 2600, stretch: 2400, perk: 450 };
export type PipAct = keyof typeof ACT_MS;

/** What Pip does on its own now and then. Repeats weight the draw. */
const IDLE: Record<PipMood, readonly PipAct[]> = {
  sleepy: ["nod", "nod", "stretch"],
  alert: ["look", "look", "look", "hop", "hop", "wave", "wave", "scan", "scan", "spin"],
  working: ["scan", "scan", "scan", "look", "look", "hop", "wave", "spin"],
};

/** How Pip answers a live engine event, as [act, rank]: it flinches at failures, celebrates wins and glances at warnings. */
function reaction(kind: string, level: string): [PipAct, number] | null {
  if (level === "error") return ["startle", 3];
  if (level === "success") return [kind === "swarm.pr" || kind === "swarm.log" || kind === "demo.seeded" ? "cheer" : kind === "gate.soundness" ? "surprise" : "hop", 2];
  if (level === "warn") return ["look", 1];
  if (kind === "source.fetched" || kind === "technique.matched") return ["scan", 1];
  if (kind === "swarm.queued") return ["hop", 1];
  return null;
}

const STAR = "M0-3.2L.9-.9 3.2 0 .9.9 0 3.2-.9.9-3.2 0-.9-.9Z";
const SPARKLES = [
  [5, 9, 1, "var(--color-sky)"],
  [44, 17, 0.8, "var(--color-olive)"],
  [2.5, 31, 0.7, "var(--color-sand)"],
  [46, 35, 1, "var(--color-sky)"],
] as const;

/**
 * Pip, elevate's lookout: a small radar critter. It dozes when nothing is waiting, perks up when a
 * recommendation is ready and gets busy while a swarm runs. Its eyes follow the pointer, `awake` opens a
 * dozing Pip's eyes and `act` plays a one-off move (see usePipActs). All motion is CSS and holds still
 * when motion is reduced (Settings → Motion, or the system; see globals.css).
 */
export function Pip({ mood, size = 44, awake = false, act, className }: { mood: PipMood; size?: number; awake?: boolean; act?: PipAct | null; className?: string }) {
  const ref = useRef<SVGSVGElement>(null);
  const reduce = usePrefersReducedMotion();
  const sleeping = mood === "sleepy" && !awake;

  useEffect(() => {
    if (sleeping || reduce || !matchMedia("(pointer: fine)").matches) return;
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
  }, [sleeping, reduce]);

  const signal = mood === "alert" ? "var(--color-olive)" : mood === "working" ? "var(--color-sky)" : "var(--color-faint)";
  const ry = mood === "alert" ? 3.9 : 3.3;
  return (
    <svg ref={ref} viewBox="0 0 48 48" width={size} height={size} className={cn("pip", className)} data-mood={mood} data-act={act ?? undefined} aria-hidden>
      <g className="pip-ground">
        <ellipse cx="24" cy="44.5" rx="11" ry="1.6" className="pip-shadow" />
      </g>
      {/* Acts move the actor; the mood's idle loop moves the body inside it, so both play at once. */}
      <g className="pip-actor">
        <g className="pip-body">
          {/* Antenna with a signal light. */}
          <g className="pip-antenna">
            <path d="M24 13V6.5" stroke="var(--color-muted)" strokeWidth="1.6" strokeLinecap="round" />
            <circle cx="24" cy="5" r="4" fill="none" stroke={signal} strokeWidth="1" className="pip-ping" />
            <circle cx="24" cy="5" r="2.2" fill={signal} className="pip-light" />
          </g>
          {/* Arms and feet first, so the body overlaps them. Arms swing from the shoulder. */}
          <g fill="var(--pip-shade)">
            <g className="pip-arm-l">
              <rect x="5.5" y="26.5" width="5" height="9" rx="2.5" />
            </g>
            <g className="pip-arm-r">
              <rect x="37.5" y="26.5" width="5" height="9" rx="2.5" />
            </g>
            <rect x="14" y="38.5" width="7" height="5" rx="2.5" />
            <rect x="27" y="38.5" width="7" height="5" rx="2.5" />
          </g>
          <rect x="8" y="12" width="32" height="29" rx="12" fill="var(--pip-fur)" />
          <path d="M13 31c2 5 6 7.5 11 7.5s9-2.5 11-7.5" fill="none" stroke="var(--pip-shade)" strokeWidth="1.4" strokeLinecap="round" opacity="0.55" />
          {sleeping ? (
            <g className="pip-shut" fill="none" stroke="var(--pip-ink)" strokeWidth="1.8" strokeLinecap="round">
              <path d="M15 25.5q3 2.4 6 0" />
              <path d="M27 25.5q3 2.4 6 0" />
            </g>
          ) : (
            <g className="pip-eyes" fill="var(--pip-ink)">
              <g className="pip-glance">
                <g className="pip-look">
                  <ellipse cx="18" cy="24.5" rx="2.9" ry={ry} />
                  <ellipse cx="30" cy="24.5" rx="2.9" ry={ry} />
                  <circle cx="19" cy="23.2" r="0.9" fill="var(--pip-fur)" />
                  <circle cx="31" cy="23.2" r="0.9" fill="var(--pip-fur)" />
                </g>
              </g>
            </g>
          )}
          {/* Happy eyes, shown while it waves or cheers. */}
          <g className="pip-happy" fill="none" stroke="var(--pip-ink)" strokeWidth="1.8" strokeLinecap="round">
            <path d="M15 26q3-3.4 6 0" />
            <path d="M27 26q3-3.4 6 0" />
          </g>
          <circle cx="13.5" cy="30" r="2" fill="var(--color-danger)" opacity="0.28" />
          <circle cx="34.5" cy="30" r="2" fill="var(--color-danger)" opacity="0.28" />
          <g className="pip-mouth">
            {mood === "alert" ? (
              <path d="M21 30.5q3 3.6 6 0z" fill="var(--pip-ink)" />
            ) : (
              <path d={mood === "working" ? "M21.5 31.5h5" : "M22 31q2 1.4 4 0"} fill="none" stroke="var(--pip-ink)" strokeWidth="1.5" strokeLinecap="round" />
            )}
          </g>
          <ellipse cx="24" cy="32" rx="1.9" ry="2.3" fill="var(--pip-ink)" className="pip-yawn" />
        </g>
      </g>
      {sleeping && (
        <g className="pip-zzz" fill="var(--color-faint)" fontSize="7" fontWeight="700" fontFamily="var(--font-sans)">
          <text x="36" y="13">z</text>
          <text x="40.5" y="7.5" fontSize="5.5">
            z
          </text>
        </g>
      )}
      <g className="pip-bang">
        <rect x="40.4" y="0" width="2.6" height="7.6" rx="1.3" />
        <circle cx="41.7" cy="10.6" r="1.45" />
      </g>
      {/* Each sparkle animates inside a positioned group, so its own transform can't knock it out of place. */}
      <g className="pip-sparkles">
        {SPARKLES.map(([x, y, s, fill]) => (
          <g key={`${x},${y}`} transform={`translate(${x} ${y}) scale(${s})`}>
            <path d={STAR} fill={fill} className="pip-sparkle" />
          </g>
        ))}
      </g>
    </svg>
  );
}

/** Shown or hidden from the bubble or ⌘K. The server renders the cookie as <html data-pip>, which stays the source of truth. */
const pipShownNow = () => document.documentElement.dataset.pip !== "off";

function subscribePip(onChange: () => void) {
  const obs = new MutationObserver(onChange);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-pip"] });
  return () => obs.disconnect();
}

/** `initial` is what the server read from the cookie, so the first render matches its HTML. */
export function usePipShown(initial = true) {
  return useSyncExternalStore(subscribePip, pipShownNow, () => initial);
}

export function setPipShown(shown: boolean) {
  document.documentElement.dataset.pip = shown ? "on" : "off";
  setPrefCookie(PIP_COOKIE, shown ? "on" : "off");
}

export const togglePip = () => setPipShown(!pipShownNow());

const HELLO_KEY = "elevate-pip-hello";

/**
 * Pip's acts for the Pip inside `host`: a wave hello once per visit, idle moves every 8–20 s (not while
 * `paused`), reactions to live events and mood changes, and whatever the caller plays. A higher rank
 * interrupts a lower one, and reactions back off so a burst of events doesn't keep it bouncing. Nothing
 * plays while motion is reduced, the tab is hidden or the host isn't rendered (each Pip shows at one
 * breakpoint only). `stirred` is true while an act should open a dozing Pip's eyes.
 */
export function usePipActs(host: RefObject<HTMLElement | null>, mood: PipMood, paused = false) {
  const reduce = usePrefersReducedMotion();
  const [act, setAct] = useState<PipAct | null>(null);
  const [stirred, setStirred] = useState(false);
  const timers = useRef({ frame: 0, end: 0, stir: 0, stirUntil: 0 });
  const playing = useRef({ rank: -1, until: 0 });
  const reacted = useRef({ rank: -1, at: 0 });
  const prevMood = useRef(mood);

  useEffect(() => {
    const t = timers.current;
    return () => {
      cancelAnimationFrame(t.frame);
      clearTimeout(t.end);
      clearTimeout(t.stir);
    };
  }, []);

  const stir = useCallback((ms: number) => {
    const t = timers.current;
    t.stirUntil = Math.max(t.stirUntil, Date.now() + ms);
    setStirred(true);
    clearTimeout(t.stir);
    t.stir = window.setTimeout(() => setStirred(false), t.stirUntil - Date.now());
  }, []);

  const play = useCallback(
    (next: PipAct, rank = 0) => {
      const el = host.current;
      const now = Date.now();
      if (reduce || !el || !el.getClientRects().length || document.hidden) return false;
      if (now < playing.current.until && rank < playing.current.rank) return false;
      playing.current = { rank, until: now + ACT_MS[next] };
      if (next !== "nod" && next !== "stretch") stir(ACT_MS[next] + 1500);
      const t = timers.current;
      cancelAnimationFrame(t.frame);
      clearTimeout(t.end);
      setAct(null);
      // Render a frame without an act first, so playing the same act again restarts its animations.
      t.frame = requestAnimationFrame(() => {
        t.frame = requestAnimationFrame(() => {
          setAct(next);
          t.end = window.setTimeout(() => setAct(null), ACT_MS[next]);
        });
      });
      return true;
    },
    [host, reduce, stir],
  );

  const react = useCallback(
    (next: PipAct, rank: number) => {
      const now = Date.now();
      const last = reacted.current;
      if (rank <= last.rank && now - last.at < (rank >= 2 ? 4000 : 10000)) return;
      if (play(next, rank)) reacted.current = { rank, at: now };
    },
    [play],
  );

  useEffect(() => {
    const on = (e: Event) => {
      const { kind, level } = (e as CustomEvent<{ kind: string; level: string }>).detail;
      const r = reaction(kind, level);
      if (r) react(...r);
    };
    window.addEventListener("elevate:event", on);
    return () => window.removeEventListener("elevate:event", on);
  }, [react]);

  useEffect(() => {
    if (prevMood.current === mood) return;
    prevMood.current = mood;
    if (mood === "alert") react("surprise", 2);
    else if (mood === "working") react("hop", 1);
  }, [mood, react]);

  useEffect(() => {
    if (reduce || paused) return;
    const pool = IDLE[mood];
    const pick = () => pool[Math.floor(Math.random() * pool.length)];
    let last: PipAct | undefined;
    let timer = 0;
    const later = () => {
      timer = window.setTimeout(() => {
        let next = pick();
        if (next === last) next = pick();
        if (next && play(next)) last = next;
        later();
      }, 8000 + Math.random() * 12000);
    };
    later();
    return () => clearTimeout(timer);
  }, [mood, paused, reduce, play]);

  useEffect(() => {
    let store: Storage;
    try {
      store = sessionStorage;
      if (store.getItem(HELLO_KEY)) return;
    } catch {
      return;
    }
    const t = window.setTimeout(() => {
      if (play("wave", 1)) store.setItem(HELLO_KEY, "1");
    }, 900);
    return () => clearTimeout(t);
  }, [play]);

  return { act, play, stirred, stir };
}

/** Keeps the floating Pip above `ref` (the chat composer) while it's mounted, through --pip-lift on <html>. */
export function usePipClearance(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const obs = new ResizeObserver(() => root.style.setProperty("--pip-lift", `${el.offsetHeight}px`));
    obs.observe(el);
    return () => {
      obs.disconnect();
      root.style.removeProperty("--pip-lift");
    };
  }, [ref]);
}

const LINES: Record<PipMood, (c: Counts) => { text: string; href: string; cta: string }> = {
  alert: (c) => ({ text: `${c.open} recommendation${c.open === 1 ? " is" : "s are"} ready for you.`, href: "/#inbox", cta: "Open the inbox" }),
  working: (c) => ({ text: `${c.activeSwarms} swarm${c.activeSwarms === 1 ? " is" : "s are"} at work. I'm keeping watch.`, href: "/swarms", cta: "See the swarms" }),
  sleepy: () => ({ text: "All quiet. I'm watching your sources and will wake up when something fits your repos.", href: "/radar", cta: "Look at the radar" }),
};

/**
 * Pip floats in the bottom-right corner from md up; phones get it in the top bar. Click it for a one-line
 * status. "Hide Pip" in the bubble (with Undo) or ⌘K → Show / hide Pip toggles it. It steps up out of the
 * way of the chat composer (usePipClearance), and the page, toasts and back-to-top leave room for it.
 */
export function PipDock({ counts, initialShown = true }: { counts: Counts; initialShown?: boolean }) {
  const dock = useRef<HTMLDivElement>(null);
  const shown = usePipShown(initialShown);
  const mod = useModKey();
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const mood = pipMood(counts);
  const line = LINES[mood](counts);
  const { act, play, stirred, stir } = usePipActs(dock, mood, open || hover || !shown);

  // Listens even while hidden, so ⌘K can bring Pip back.
  useEffect(() => {
    const toggle = () => {
      setOpen(false);
      togglePip();
    };
    window.addEventListener(PIP_EVENT, toggle);
    return () => window.removeEventListener(PIP_EVENT, toggle);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    const onDown = (e: PointerEvent) => !dock.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [open]);

  if (!shown) return null;
  return (
    <div
      ref={dock}
      data-testid="pip"
      className="pointer-events-none fixed bottom-5 right-5 z-40 transition-[translate] duration-300 ease-[var(--ease-out)] max-md:hidden"
      style={{ translate: "0 calc(var(--pip-lift, 0px) * -1)" }}
    >
      {open && (
        <div
          role="status"
          data-testid="pip-bubble"
          className="pip-bubble pointer-events-auto absolute bottom-full right-0 mb-2 w-60 rounded-xl border border-line-strong bg-raised p-3 text-xs shadow-xl"
        >
          <p className="text-pretty text-fg">{line.text}</p>
          <div className="mt-2 flex items-center justify-between gap-2">
            <Link href={line.href} onClick={() => setOpen(false)} className="text-sky underline decoration-sky/40 underline-offset-4 hover:decoration-sky">
              {line.cta}
            </Link>
            <button
              type="button"
              className="text-faint hover:text-fg"
              onClick={() => {
                setOpen(false);
                setPipShown(false);
                toast("Pip is hidden", {
                  description: `Bring it back with ${mod}K → Show / hide Pip.`,
                  action: { label: "Undo", onClick: () => setPipShown(true) },
                });
              }}
            >
              Hide Pip
            </button>
          </div>
          {/* Tail, pointing down at Pip. */}
          <span aria-hidden className="absolute -bottom-[5px] right-[27px] size-2.5 rotate-45 border-b border-r border-line-strong bg-raised" />
        </div>
      )}
      <button
        type="button"
        aria-label={`Pip, your lookout: ${line.text}`}
        aria-expanded={open}
        onClick={() => {
          setOpen((o) => !o);
          play("hop", 2);
        }}
        onPointerEnter={() => {
          setHover(true);
          if (mood === "sleepy") play("perk", 1);
        }}
        onPointerLeave={() => {
          setHover(false);
          stir(1200);
        }}
        onFocus={(e) => setFocus(e.currentTarget.matches(":focus-visible"))}
        onBlur={() => setFocus(false)}
        className="pointer-events-auto block rounded-2xl p-1 transition-[scale] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky active:scale-95"
      >
        <span className="pip-enter block">
          <Pip mood={mood} size={56} awake={hover || focus || open || stirred} act={act} />
        </span>
      </button>
    </div>
  );
}
