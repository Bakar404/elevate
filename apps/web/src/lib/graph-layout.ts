import type { ActivityGraph as Graph } from "@elevate/engine";

/** Geometry of the home-screen live map, kept free of React so it can be tested on its own. */
export const W = 760;
export const H = 360;
export const CX = W / 2;
export const CY = H / 2;
export const REPO = { rx: 205, ry: 108 };
export const TECH = { rx: 330, ry: 150 };

export type Pos = { x: number; y: number; a: number };
export type Anchor = "start" | "middle" | "end";
export type Label = { text: string; x: number; y: number; anchor: Anchor };
export type Box = { x0: number; y0: number; x1: number; y1: number };

// Rough advance widths in viewBox units: close enough to keep labels apart, and the same on server and client,
// which measuring rendered text wouldn't be.
const TECH_CH = 6.3; // 11px sans
const REPO_CH = 6.9; // 11.5px mono

/** Node's and the browser's Math.sin/cos can differ in the last digit; rounding keeps server and client markup identical. */
export const round = (v: number) => Math.round(v * 100) / 100;
const onEllipse = (a: number, e: { rx: number; ry: number }): Pos => ({ x: round(CX + Math.cos(a) * e.rx), y: round(CY + Math.sin(a) * e.ry), a });
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Cut to at most `max` characters, at a word boundary when there's one in the back half. */
export function shorten(s: string, max: number) {
  if (s.length <= max) return s;
  let cut = max - 1;
  for (let i = max - 1; i >= Math.ceil(max / 2); i--) {
    if (s[i] === " " || s[i - 1] === "/" || s[i - 1] === "-") {
      cut = i;
      break;
    }
  }
  return `${s.slice(0, cut).replace(/[\s,;:/–—-]+$/, "")}…`;
}

/** A technique's map label: its name without "(…)" asides, cut at a word boundary. The full name is in the tooltip. */
export function techLabel(name: string, max: number) {
  const bare = name.replace(/\s*\([^)]*(\)|$)/g, "").trim();
  return shorten(bare.length >= 3 ? bare : name.trim(), max);
}

/** Spread angles round the circle so no two sit closer than `gap` radians, keeping their order. */
export function spread(angles: { id: string; a: number }[], gap: number) {
  const s = angles.map((x) => ({ ...x })).sort((p, q) => p.a - q.a);
  for (let pass = 0; pass < 60 && s.length > 1; pass++) {
    let moved = false;
    for (let i = 0; i < s.length; i++) {
      const cur = s[i]!;
      const next = s[(i + 1) % s.length]!;
      const d = next.a - cur.a + (i === s.length - 1 ? 2 * Math.PI : 0);
      if (d < gap - 1e-6) {
        cur.a -= (gap - d) / 2;
        next.a += (gap - d) / 2;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return new Map(s.map((x) => [x.id, x.a]));
}

const textBox = (x: number, y: number, w: number, anchor: Anchor): Box => {
  const x0 = anchor === "start" ? x : anchor === "end" ? x - w : x - w / 2;
  return { x0, y0: y - 10, x1: x0 + w, y1: y + 3 };
};
/** The area a label covers, in viewBox units. `extra` counts characters drawn after the text (a repo's open count). */
export const labelBox = (l: Label, kind: "tech" | "repo", extra = 0): Box =>
  textBox(l.x, l.y, (l.text.length + extra) * (kind === "tech" ? TECH_CH : REPO_CH), l.anchor);
const around = (p: { x: number; y: number }, r: number): Box => ({ x0: p.x - r, y0: p.y - r, x1: p.x + r, y1: p.y + r });
export const overlaps = (a: Box, b: Box, pad = 2) => a.x0 < b.x1 + pad && b.x0 < a.x1 + pad && a.y0 < b.y1 + pad && b.y0 < a.y1 + pad;
export const inside = (b: Box) => b.x0 >= 2 && b.x1 <= W - 2 && b.y0 >= 2 && b.y1 <= H - 2;

/** The first spot whose label fits on the map without covering anything already placed, which it then claims. */
function claim(spots: Label[], kind: "tech" | "repo", taken: Box[], extra = 0): Label | null {
  for (const spot of spots) {
    const box = labelBox(spot, kind, extra);
    if (inside(box) && !taken.some((o) => overlaps(o, box))) {
      taken.push(box);
      return spot;
    }
  }
  return null;
}

/** A repo's name sits just outside its node, away from the hub, unless a technique is in the way. It's always shown. */
function repoLabel(r: Graph["repos"][number], p: Pos, taken: Box[]) {
  const c = Math.cos(p.a);
  const outer = Math.sin(p.a) < 0 ? -1 : 1;
  const anchor: Anchor = c > 0.35 ? "start" : c < -0.35 ? "end" : "middle";
  const beside = (text: string): Label => ({ text, x: round(p.x + c * 14), y: round(p.y + Math.sin(p.a) * 16 + 4), anchor });
  const over = (text: string, dir: number): Label => ({ text, x: round(p.x), y: round(p.y + (dir < 0 ? -12 : 21)), anchor: "middle" });
  const extra = r.open > 0 ? ` ${r.open}`.length : 0;
  const spots = [shorten(r.name, 20), shorten(r.name, 12)].flatMap((text) => [beside(text), over(text, outer), over(text, -outer)]);
  return claim(spots, "repo", taken, extra) ?? spots[0]!;
}

/**
 * Technique labels, most important technique first: above or below the node, then beside it, then a shorter
 * name. A label that still collides is left off; its node keeps the full name as a tooltip.
 */
function techLabels(g: Graph, techPos: Map<string, Pos>, taken: Box[]) {
  return new Map(
    g.techniques.map((t) => {
      const p = techPos.get(t.id)!;
      const above = p.y < CY;
      const outward = p.x >= CX ? 1 : -1;
      const spots = [techLabel(t.name, 26), techLabel(t.name, 15)].flatMap((text) => {
        const w = text.length * TECH_CH;
        const mid = (dy: number): Label => ({ text, x: round(clamp(p.x, w / 2 + 4, W - w / 2 - 4)), y: round(p.y + dy), anchor: "middle" });
        const side = (dir: number): Label => ({ text, x: round(p.x + dir * 11), y: round(p.y + 4), anchor: dir > 0 ? "start" : "end" });
        return [mid(above ? -13 : 21), mid(above ? 21 : -13), side(outward), side(-outward)];
      });
      return [t.id, claim(spots, "tech", taken)] as const;
    }),
  );
}

export function layout(g: Graph) {
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

  // Nodes first (as drawn: repo rings have r=6 and diamonds reach about 7 from their centre), then repo names
  // (busiest repo first), then technique names in the gaps.
  const taken: Box[] = [around({ x: CX, y: CY }, 32), ...[...repoPos.values()].map((p) => around(p, 6)), ...[...techPos.values()].map((p) => around(p, 7))];
  const repoLabels = new Map(g.repos.map((r) => [r.id, repoLabel(r, repoPos.get(r.id)!, taken)]));
  return { repoPos, techPos, repoLabels, techLabels: techLabels(g, techPos, taken) };
}

/** Curve from a technique into a repo, bowed toward the hub. */
export function linkPath(from: Pos, to: Pos) {
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const qx = mx + (CX - mx) * 0.3;
  const qy = my + (CY - my) * 0.3;
  return `M${from.x.toFixed(1)},${from.y.toFixed(1)} Q${qx.toFixed(1)},${qy.toFixed(1)} ${to.x.toFixed(1)},${to.y.toFixed(1)}`;
}

const URGENCY: Record<string, number> = { approved: 3, in_progress: 3, pr_opened: 2, open: 1 };

/** How many moving dots each link gets: in-flight work first, then the best scores, up to `budget` in all, so a busy map stays calm. */
export function particleBudget(links: Graph["links"], want: (status: string) => number, budget = 24) {
  const order = [...links].sort((a, b) => (URGENCY[b.status] ?? 0) - (URGENCY[a.status] ?? 0) || (b.score ?? 0) - (a.score ?? 0));
  const out = new Map<string, number>();
  let left = budget;
  for (const l of order) {
    const n = Math.min(want(l.status), left);
    out.set(l.id, n);
    left -= n;
  }
  return out;
}
