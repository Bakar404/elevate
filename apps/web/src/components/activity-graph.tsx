"use client";

import type { ActivityGraph as Graph } from "@elevate/engine";
import { motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { LogoVariant } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { LogoMark } from "./logo";

const W = 760;
const H = 360;
const CX = W / 2;
const CY = H / 2;
const REPO = { rx: 205, ry: 108 };
const TECH = { rx: 330, ry: 150 };

const STATE_COLOR = { working: "var(--color-sky)", review: "var(--color-olive)", watched: "var(--color-cloud)" } as const;
const LINK_STYLE: Record<string, { color: string; dash?: string; speed?: number; particles: number }> = {
  candidate: { color: "var(--color-faint)", dash: "3 5", particles: 0 },
  open: { color: "var(--color-olive)", speed: 3.2, particles: 1 },
  approved: { color: "var(--color-sky)", speed: 1.8, particles: 2 },
  in_progress: { color: "var(--color-sky)", speed: 1.6, particles: 2 },
  pr_opened: { color: "var(--color-sand)", particles: 0 },
};

type Pos = { x: number; y: number; a: number };
const onEllipse = (a: number, e: { rx: number; ry: number }): Pos => ({ x: CX + Math.cos(a) * e.rx, y: CY + Math.sin(a) * e.ry, a });
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Spread angles so no two sit closer than `gap` radians, keeping their order. */
function spread(angles: { id: string; a: number }[], gap: number) {
  const sorted = [...angles].sort((p, q) => p.a - q.a);
  for (let pass = 0; pass < 8; pass++) {
    for (let i = 1; i < sorted.length; i++) {
      const d = sorted[i]!.a - sorted[i - 1]!.a;
      if (d < gap) {
        sorted[i - 1]!.a -= (gap - d) / 2;
        sorted[i]!.a += (gap - d) / 2;
      }
    }
  }
  return new Map(sorted.map((s) => [s.id, s.a]));
}

function layout(g: Graph) {
  const n = Math.max(g.repos.length, 1);
  const repoPos = new Map(g.repos.map((r, i) => [r.id, onEllipse(-Math.PI / 2 + (i * 2 * Math.PI) / n, REPO)]));
  const techAngles = g.techniques.map((t) => {
    // Circular mean of the repos this technique touches, so links stay short.
    const linked = g.links.filter((l) => l.techniqueId === t.id).map((l) => repoPos.get(l.repoId)!.a);
    const a = Math.atan2(
      linked.reduce((s, x) => s + Math.sin(x), 0),
      linked.reduce((s, x) => s + Math.cos(x), 0),
    );
    return { id: t.id, a };
  });
  const angles = spread(techAngles, (2 * Math.PI) / Math.max(10, g.techniques.length * 1.4));
  const techPos = new Map(g.techniques.map((t) => [t.id, onEllipse(angles.get(t.id) ?? 0, TECH)]));
  return { repoPos, techPos };
}

/** Curve from a technique into a repo, bowed toward the hub. */
function linkPath(from: Pos, to: Pos) {
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const qx = mx + (CX - mx) * 0.3;
  const qy = my + (CY - my) * 0.3;
  return `M${from.x.toFixed(1)},${from.y.toFixed(1)} Q${qx.toFixed(1)},${qy.toFixed(1)} ${to.x.toFixed(1)},${to.y.toFixed(1)}`;
}

function Particle({ d, color, dur, begin, r = 2.2 }: { d: string; color: string; dur: number; begin: number; r?: number }) {
  return (
    <g>
      <circle r={r * 2.6} fill={color} opacity={0}>
        <animateMotion dur={`${dur}s`} begin={`${begin}s`} repeatCount="indefinite" path={d} />
        <animate attributeName="opacity" values="0;0.22;0.22;0" keyTimes="0;0.15;0.85;1" dur={`${dur}s`} begin={`${begin}s`} repeatCount="indefinite" />
      </circle>
      <circle r={r} fill={color} opacity={0}>
        <animateMotion dur={`${dur}s`} begin={`${begin}s`} repeatCount="indefinite" path={d} />
        <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.15;0.85;1" dur={`${dur}s`} begin={`${begin}s`} repeatCount="indefinite" />
      </circle>
    </g>
  );
}

export function ActivityGraph({ data, logo }: { data: Graph; logo?: LogoVariant }) {
  const reduce = useReducedMotion();
  const router = useRouter();
  const [hover, setHover] = useState<string | null>(null);
  const { repoPos, techPos } = useMemo(() => layout(data), [data]);

  const lit = useMemo(() => {
    if (!hover) return null;
    const s = new Set([hover]);
    for (const l of data.links) {
      if (l.repoId === hover || l.techniqueId === hover) {
        s.add(l.repoId);
        s.add(l.techniqueId);
        s.add(l.id);
      }
    }
    return s;
  }, [hover, data.links]);
  const dim = (id: string) => (lit && !lit.has(id) ? 0.3 : 1);

  const counts = {
    working: data.repos.filter((r) => r.state === "working").length,
    review: data.repos.filter((r) => r.state === "review").length,
    watched: data.repos.filter((r) => r.state === "watched").length,
  };

  return (
    <div data-testid="activity-graph" className="relative overflow-hidden rounded-2xl border border-line bg-bg/60 backdrop-blur-md">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line px-5 py-3 text-xs text-muted">
        <span className="font-medium text-fg">Live map</span>
        <Legend color="var(--color-sky)" label={`${counts.working} being worked on`} pulse={counts.working > 0} />
        <Legend color="var(--color-olive)" label={`${counts.review} awaiting review`} />
        <Legend color="var(--color-cloud)" label={`${counts.watched} watched`} />
        <Legend color="var(--color-sand)" label={`${data.techniques.length} matched technique${data.techniques.length === 1 ? "" : "s"}`} square />
        {data.hidden > 0 && (
          <Link href="/repos" className="ml-auto text-faint transition-colors hover:text-fg">
            +{data.hidden} more
          </Link>
        )}
      </div>

      {data.repos.length === 0 ? (
        <div className="grid h-56 place-items-center text-center text-sm text-muted">
          <div>
            No repos watched yet.{" "}
            <Link href="/repos" className="text-sky underline underline-offset-4">
              Pick some to watch
            </Link>{" "}
            and they'll show up here.
          </div>
        </div>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} className="block h-auto w-full select-none" onMouseLeave={() => setHover(null)}>
          <defs>
            <pattern id="graph-dots" width="18" height="18" patternUnits="userSpaceOnUse">
              <circle cx="1" cy="1" r="0.8" fill="var(--color-ink)" opacity="0.07" />
            </pattern>
            <radialGradient id="graph-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0" stopColor="var(--color-sky)" stopOpacity="0.16" />
              <stop offset="1" stopColor="var(--color-sky)" stopOpacity="0" />
            </radialGradient>
          </defs>
          <rect width={W} height={H} fill="url(#graph-dots)" />
          <ellipse cx={CX} cy={CY} rx={REPO.rx * 0.9} ry={REPO.ry * 0.95} fill="url(#graph-glow)" />
          <ellipse cx={CX} cy={CY} rx={REPO.rx} ry={REPO.ry} fill="none" stroke="var(--color-line)" strokeDasharray="2 6" />
          {data.techniques.length > 0 && <ellipse cx={CX} cy={CY} rx={TECH.rx} ry={TECH.ry} fill="none" stroke="var(--color-line)" strokeDasharray="1 9" />}

          {/* Spokes: the hub watching each repo. */}
          {data.repos.map((r, i) => {
            const p = repoPos.get(r.id)!;
            const d = `M${CX},${CY} L${p.x.toFixed(1)},${p.y.toFixed(1)}`;
            const color = STATE_COLOR[r.state];
            return (
              <g key={`spoke-${r.id}`} style={{ opacity: dim(r.id), transition: "opacity 200ms" }}>
                <motion.path
                  d={d}
                  stroke={r.state === "watched" ? "var(--color-line-strong)" : color}
                  strokeOpacity={r.state === "watched" ? 1 : 0.45}
                  strokeWidth={1}
                  fill="none"
                  initial={reduce ? false : { pathLength: 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ duration: 0.6, delay: 0.15 + i * 0.04, ease: [0.23, 1, 0.32, 1] }}
                />
                {!reduce && <Particle d={d} color={color} dur={r.state === "working" ? 1.4 : 5 + (i % 4)} begin={(i * 0.73) % 4} r={r.state === "watched" ? 1.4 : 2} />}
                {!reduce && r.state === "working" && <Particle d={d} color={color} dur={1.4} begin={0.7 + i * 0.1} />}
              </g>
            );
          })}

          {/* Technique → repo: one curve per live recommendation. */}
          {data.links.map((l, i) => {
            const from = techPos.get(l.techniqueId);
            const to = repoPos.get(l.repoId);
            if (!from || !to) return null;
            const d = linkPath(from, to);
            const s = LINK_STYLE[l.status] ?? LINK_STYLE.open!;
            return (
              <g key={l.id} style={{ opacity: dim(l.id), transition: "opacity 200ms" }}>
                <motion.path
                  d={d}
                  stroke={s.color}
                  strokeOpacity={0.55}
                  strokeWidth={1.2}
                  strokeDasharray={s.dash}
                  className={s.dash && !reduce ? "graph-march" : undefined}
                  fill="none"
                  initial={reduce ? false : { pathLength: 0, opacity: 0 }}
                  animate={{ pathLength: 1, opacity: 1 }}
                  transition={{ duration: 0.8, delay: 0.5 + i * 0.05, ease: [0.23, 1, 0.32, 1] }}
                />
                {!reduce &&
                  Array.from({ length: s.particles }, (_, k) => (
                    <Particle key={k} d={d} color={s.color} dur={s.speed!} begin={(k * s.speed!) / s.particles + (i % 5) * 0.3} />
                  ))}
              </g>
            );
          })}

          {/* Hub. */}
          <g transform={`translate(${CX - 20},${CY - 20})`}>
            <circle cx={20} cy={20} r={30} fill="none" stroke="var(--color-line-strong)" strokeDasharray="3 5" className={reduce ? undefined : "graph-spin"} />
            <LogoMark variant={logo} size={40} />
          </g>

          {data.techniques.map((t, i) => {
            const p = techPos.get(t.id)!;
            const above = p.y < CY;
            const lx = clamp(p.x, 80, W - 80);
            return (
              <g key={t.id} style={{ opacity: dim(t.id), transition: "opacity 200ms" }}>
              <motion.g
                className="cursor-pointer"
                onMouseEnter={() => setHover(t.id)}
                onClick={() => router.push("/radar")}
                initial={reduce ? false : { opacity: 0, scale: 0.6 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.4, delay: 0.4 + i * 0.05, ease: [0.23, 1, 0.32, 1] }}
                style={{ transformOrigin: `${p.x}px ${p.y}px` }}
              >
                <title>{`${t.name}${t.category ? ` · ${t.category}` : ""}`}</title>
                <rect x={p.x - 5} y={p.y - 5} width={10} height={10} rx={2.5} transform={`rotate(45 ${p.x} ${p.y})`} fill="var(--color-bg)" stroke="var(--color-sand)" strokeWidth={1.5} />
                <rect x={p.x - 2} y={p.y - 2} width={4} height={4} rx={1} transform={`rotate(45 ${p.x} ${p.y})`} fill="var(--color-sand)" />
                <text x={lx} y={above ? p.y - 13 : p.y + 21} textAnchor="middle" fontSize={11} fill="var(--color-sand)" fillOpacity={0.85}>
                  {short(t.name, 24)}
                </text>
              </motion.g>
              </g>
            );
          })}

          {data.repos.map((r, i) => {
            const p = repoPos.get(r.id)!;
            const color = STATE_COLOR[r.state];
            const c = Math.cos(p.a);
            const anchor = c > 0.35 ? "start" : c < -0.35 ? "end" : "middle";
            const lx = p.x + c * 14;
            const ly = p.y + Math.sin(p.a) * 16 + 4;
            return (
              <g key={r.id} style={{ opacity: dim(r.id), transition: "opacity 200ms" }}>
              <motion.g
                data-testid="graph-repo"
                data-state={r.state}
                className="cursor-pointer"
                onMouseEnter={() => setHover(r.id)}
                onClick={() => router.push("/repos")}
                initial={reduce ? false : { opacity: 0, scale: 0.5 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.45, delay: 0.2 + i * 0.04, ease: [0.23, 1, 0.32, 1] }}
                style={{ transformOrigin: `${p.x}px ${p.y}px` }}
              >
                <title>{`${r.fullName}${r.language ? ` · ${r.language}` : ""}${r.open ? ` · ${r.open} to review` : ""}${r.prs ? ` · ${r.prs} draft PR${r.prs === 1 ? "" : "s"}` : ""}`}</title>
                <circle cx={p.x} cy={p.y} r={16} fill="transparent" />
                {r.state !== "watched" && !reduce && (
                  <circle cx={p.x} cy={p.y} r={6} fill="none" stroke={color} strokeWidth={1.5} className="graph-ping" style={{ animationDelay: `${(i % 5) * 0.35}s` }} />
                )}
                <circle cx={p.x} cy={p.y} r={r.state === "watched" ? 4.5 : 6} fill="var(--color-bg)" stroke={color} strokeWidth={1.6} strokeOpacity={r.state === "watched" ? 0.6 : 1} />
                <circle cx={p.x} cy={p.y} r={r.state === "watched" ? 1.6 : 2.6} fill={color} fillOpacity={r.state === "watched" ? 0.7 : 1} />
                <text x={lx} y={ly} textAnchor={anchor} fontSize={11.5} fill={r.state === "watched" ? "var(--color-muted)" : "var(--color-fg)"} className="font-mono">
                  {short(r.name, 20)}
                  {r.open > 0 && <tspan fill="var(--color-olive)">{` ${r.open}`}</tspan>}
                </text>
              </motion.g>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

function Legend({ color, label, pulse, square }: { color: string; label: string; pulse?: boolean; square?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="relative grid size-2 place-items-center">
        {pulse && <span className="absolute inset-0 animate-ping rounded-full" style={{ background: color, opacity: 0.6 }} />}
        <span className={cn("relative size-2", square ? "rotate-45 rounded-[2px]" : "rounded-full")} style={{ background: color }} />
      </span>
      {label}
    </span>
  );
}
