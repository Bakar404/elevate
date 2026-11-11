// Generates the README / Pages diagrams as SVG in the app's own palette, one file per theme.
// Run: node scripts/diagrams.mjs  (writes docs/images/*-{dark,light}.svg)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "images");
mkdirSync(out, { recursive: true });

// Hex equivalents of the oklch tokens in apps/web/src/app/globals.css.
const THEMES = {
  dark: {
    bg: "#0d1015", panel: "#14181e", raised: "#1b2027", line: "rgba(255,255,255,0.08)", lineStrong: "rgba(255,255,255,0.15)",
    fg: "#eef1f5", muted: "#a6aeb9", faint: "#767e8a", dot: "rgba(255,255,255,0.07)",
    sky: "#5b93d9", olive: "#8fa955", sand: "#e0c37c", cloud: "#b6cbe0", danger: "#e0605a",
  },
  light: {
    bg: "#f7f9fb", panel: "#ffffff", raised: "#f0f3f6", line: "rgba(22,32,48,0.10)", lineStrong: "rgba(22,32,48,0.17)",
    fg: "#1c222b", muted: "#535c68", faint: "#7c838e", dot: "rgba(22,32,48,0.08)",
    sky: "#2f6cbf", olive: "#5b7a22", sand: "#a8731b", cloud: "#6f8aa6", danger: "#c43d36",
  },
};

const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Helvetica, Arial, sans-serif`;
const MONO = `ui-monospace, 'Cascadia Code', 'SFMono-Regular', Menlo, Consolas, monospace`;
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function frame(t, w, h, body, title) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<style>
  .flow { stroke-dasharray: 4 6; animation: march 1.4s linear infinite; }
  .ping { transform-box: fill-box; transform-origin: center; animation: ping 2.4s cubic-bezier(.23,1,.32,1) infinite; }
  @keyframes march { to { stroke-dashoffset: -20; } }
  @keyframes ping { from { transform: scale(1); opacity: .6; } to { transform: scale(2.4); opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .flow, .ping { animation: none; } }
</style>
<defs>
  <pattern id="dots" width="18" height="18" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.9" fill="${t.dot}"/></pattern>
  <radialGradient id="glow" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="${t.sky}" stop-opacity="0.14"/><stop offset="1" stop-color="${t.sky}" stop-opacity="0"/></radialGradient>
</defs>
<rect width="${w}" height="${h}" rx="18" fill="${t.bg}"/>
<rect width="${w}" height="${h}" rx="18" fill="url(#dots)"/>
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="17.5" fill="none" stroke="${t.line}"/>
${body}
</svg>
`;
}

function node(t, { x, y, w, h = 64, kicker, title, sub, accent, strong }) {
  const a = accent ? t[accent] : t.lineStrong;
  return `<g>
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="12" fill="${t.panel}" stroke="${strong ? a : t.lineStrong}" stroke-opacity="${strong ? 0.75 : 1}"/>
  ${accent ? `<rect x="${x + 12}" y="${y + 14}" width="6" height="6" rx="1.5" transform="rotate(45 ${x + 15} ${y + 17})" fill="${a}"/>` : ""}
  ${kicker ? `<text x="${x + (accent ? 26 : 14)}" y="${y + 21}" font-family="${FONT}" font-size="10" letter-spacing="0.08em" fill="${t.faint}">${esc(kicker.toUpperCase())}</text>` : ""}
  <text x="${x + 14}" y="${y + (kicker ? 41 : 30)}" font-family="${FONT}" font-size="14" font-weight="600" fill="${t.fg}">${esc(title)}</text>
  ${sub ? `<text x="${x + 14}" y="${y + (kicker ? 57 : 47)}" font-family="${FONT}" font-size="11.5" fill="${t.muted}">${esc(sub)}</text>` : ""}
</g>`;
}

const edge = (t, d, accent = "lineStrong", animated = true, opacity = 1) =>
  `<path d="${d}" fill="none" stroke="${t[accent]}" stroke-opacity="${opacity}" stroke-width="1.5" ${animated ? 'class="flow"' : ""} stroke-linecap="round"/>`;
const arrow = (t, x, y, accent = "lineStrong", dir = "r") => {
  const p = dir === "r" ? `${x - 6},${y - 4} ${x},${y} ${x - 6},${y + 4}` : dir === "d" ? `${x - 4},${y - 6} ${x},${y} ${x + 4},${y - 6}` : `${x + 6},${y - 4} ${x},${y} ${x + 6},${y + 4}`;
  return `<polyline points="${p}" fill="none" stroke="${t[accent]}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`;
};
const chip = (t, x, y, label, color) =>
  `<g><rect x="${x}" y="${y}" width="${label.length * 6.6 + 26}" height="24" rx="12" fill="${t.raised}" stroke="${t.line}"/><circle cx="${x + 12}" cy="${y + 12}" r="3" fill="${t[color]}"/><text x="${x + 21}" y="${y + 16}" font-family="${MONO}" font-size="11" fill="${t.muted}">${esc(label)}</text></g>`;
const label = (t, x, y, s, color = "faint", anchor = "start", size = 11) =>
  `<text x="${x}" y="${y}" text-anchor="${anchor}" font-family="${FONT}" font-size="${size}" fill="${t[color]}">${esc(s)}</text>`;

function pipeline(t) {
  const W = 1200, H = 470;
  const b = [];
  b.push(label(t, 32, 40, "HOW ELEVATE DECIDES WHAT TO RECOMMEND", "faint", "start", 11));
  // Sources
  const src = [["Hacker News", "sky"], ["AI lab blogs", "sky"], ["arXiv", "sky"], ["Repo-focused searches", "sand"]];
  src.forEach(([s, c], i) => b.push(chip(t, 32, 70 + i * 34, s, c)));
  b.push(edge(t, "M 214 128 C 240 128, 240 128, 262 128", "sky"), arrow(t, 262, 128, "sky"));
  b.push(node(t, { x: 268, y: 96, w: 176, kicker: "triage", title: "Technique", sub: "what it is, claimed gains" }));
  b.push(edge(t, "M 444 128 L 498 128", "sky"), arrow(t, 498, 128, "sky"));
  b.push(node(t, { x: 504, y: 90, w: 214, h: 76, kicker: "gate 1", title: "Legitimacy", sub: "credible · corroborated · code", accent: "sky", strong: true }));
  // Hype filtered branch
  b.push(edge(t, "M 611 90 L 611 66", "danger", false, 0.6));
  b.push(label(t, 611, 58, "hype kept, hidden with reasons", "danger", "middle", 11));
  // Repos row
  b.push(chip(t, 32, 300, "your GitHub repos", "olive"));
  b.push(edge(t, "M 190 312 L 262 312", "olive"), arrow(t, 262, 312, "olive"));
  b.push(node(t, { x: 268, y: 280, w: 176, kicker: "profile", title: "Stack + domains", sub: "embeddings, key modules" }));
  b.push(edge(t, "M 444 312 L 498 312", "olive"), arrow(t, 498, 312, "olive"));
  b.push(node(t, { x: 504, y: 280, w: 214, kicker: "matcher", title: "Candidate change", sub: "technique × repo, per hypothesis" }));
  b.push(edge(t, "M 611 166 L 611 274", "sky"), arrow(t, 611, 274, "sky", "d"));
  b.push(edge(t, "M 718 312 L 772 312", "olive"), arrow(t, 772, 312, "olive"));
  b.push(node(t, { x: 778, y: 274, w: 196, h: 76, kicker: "gate 2", title: "Soundness", sub: "fit · risk · measurable impact", accent: "olive", strong: true }));
  b.push(edge(t, "M 876 274 L 876 196", "olive"), arrow(t, 876, 196, "olive", "u"));
  b.push(node(t, { x: 778, y: 120, w: 196, kicker: "inbox", title: "Recommendation", sub: "evidence for both gates" }));
  b.push(edge(t, "M 974 152 L 1024 152", "sand"), arrow(t, 1024, 152, "sand"));
  b.push(label(t, 999, 142, "you approve", "sand", "middle", 10.5));
  b.push(node(t, { x: 1030, y: 120, w: 140, kicker: "swarm", title: "Plan → review", sub: "agents in parallel" }));
  b.push(edge(t, "M 1100 184 L 1100 274", "sand"), arrow(t, 1100, 274, "sand", "d"));
  b.push(`<circle cx="1100" cy="312" r="9" fill="${t.sand}" opacity="0.5" class="ping"/>`);
  b.push(node(t, { x: 1030, y: 280, w: 140, kicker: "result", title: "Draft PR", sub: "never merged", accent: "sand", strong: true }));
  b.push(`<line x1="32" x2="${W - 32}" y1="398" y2="398" stroke="${t.line}"/>`);
  b.push(label(t, 32, 428, "Gate decisions, the lifecycle and the write guard are proved in Verus and diff-tested against the TypeScript the app runs.", "muted", "start", 12));
  return frame(t, W, H, b.join("\n"), "elevate pipeline: sources and repos, two gates, approval, swarm, draft PR");
}

function swarm(t) {
  const W = 1200, H = 300;
  const b = [label(t, 32, 40, "AN APPROVED RECOMMENDATION BECOMES A TASK GRAPH", "faint")];
  const y = 110;
  b.push(node(t, { x: 32, y, w: 170, kicker: "planner", title: "Plan the change", sub: "reads the repo profile" }));
  b.push(node(t, { x: 262, y: y - 50, w: 190, kicker: "implementer", title: "Implement", sub: "worktree or cloud agent", accent: "sky" }));
  b.push(node(t, { x: 262, y: y + 50, w: 190, kicker: "implementer", title: "Before/after checks", sub: "the measure from Gate 2", accent: "sky" }));
  b.push(node(t, { x: 512, y, w: 170, kicker: "tester", title: "Verify", sub: "tests + benchmarks", accent: "olive" }));
  b.push(node(t, { x: 742, y, w: 170, kicker: "reviewer", title: "Review the diff", sub: "skeptical second model", accent: "olive" }));
  b.push(node(t, { x: 972, y, w: 196, kicker: "publisher", title: "Open a draft PR", sub: "guarded write, audited", accent: "sand", strong: true }));
  b.push(edge(t, `M 202 ${y + 32} C 232 ${y + 32}, 232 ${y - 18}, 256 ${y - 18}`, "sky"), arrow(t, 256, y - 18, "sky"));
  b.push(edge(t, `M 202 ${y + 32} C 232 ${y + 32}, 232 ${y + 82}, 256 ${y + 82}`, "sky"), arrow(t, 256, y + 82, "sky"));
  b.push(edge(t, `M 452 ${y - 18} C 482 ${y - 18}, 482 ${y + 32}, 506 ${y + 32}`, "olive"), arrow(t, 506, y + 32, "olive"));
  b.push(edge(t, `M 452 ${y + 82} C 482 ${y + 82}, 482 ${y + 32}, 506 ${y + 32}`, "olive"));
  b.push(edge(t, `M 682 ${y + 32} L 736 ${y + 32}`, "olive"), arrow(t, 736, y + 32, "olive"));
  b.push(edge(t, `M 912 ${y + 32} L 966 ${y + 32}`, "sand"), arrow(t, 966, y + 32, "sand"));
  const ex = ["Copilot coding agent", "Claude (GitHub Action)", "Codex cloud", "local copilot / claude / codex CLI"];
  let x = 32;
  b.push(label(t, 32, 262, "RUNS ON", "faint", "start", 10));
  x = 92;
  for (const e of ex) {
    b.push(chip(t, x, 246, e, "cloud"));
    x += e.length * 6.6 + 38;
  }
  return frame(t, W, H, b.join("\n"), "elevate swarm: planner, implementers, tester, reviewer, publisher");
}

function ring(t, cx, cy, r, value, color, big, small) {
  const c = 2 * Math.PI * r;
  return `<g>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${t.line}" stroke-width="6"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${t[color]}" stroke-width="6" stroke-linecap="round" stroke-dasharray="${(c * value).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 ${cx} ${cy})"/>
  <text x="${cx}" y="${cy + 7}" text-anchor="middle" font-family="${MONO}" font-size="20" font-weight="600" fill="${t.fg}">${esc(big)}</text>
  <text x="${cx}" y="${cy + r + 30}" text-anchor="middle" font-family="${FONT}" font-size="12" fill="${t.muted}">${esc(small)}</text>
</g>`;
}

function evals(t) {
  const W = 1200, H = 260;
  const b = [label(t, 32, 40, "GATE EVAL · LAST LIVE RUN ON THE COPILOT DEFAULT MODEL", "faint")];
  b.push(`<ellipse cx="600" cy="130" rx="520" ry="110" fill="url(#glow)"/>`);
  b.push(ring(t, 170, 125, 52, 1, "olive", "1.00", "Gate 1 precision"));
  b.push(ring(t, 430, 125, 52, 0.89, "sky", "0.89", "Gate 1 recall"));
  b.push(ring(t, 690, 125, 52, 0, "danger", "0 / 7", "hype cases passed"));
  b.push(ring(t, 950, 125, 52, 1, "sand", "7 / 7", "Gate 2 correct"));
  return frame(t, W, H, b.join("\n"), "Gate eval: precision 1.00, recall 0.89, 0 of 7 hype cases passed, Gate 2 7 of 7");
}

function proof(t) {
  const W = 1200, H = 210;
  const b = [label(t, 32, 40, "PROOF-DRIVEN: EVERY RULE BETWEEN A HEADLINE AND YOUR REPO", "faint")];
  const steps = [
    ["intent", "26 requirements", "plain words", null],
    ["spec + proof", "Verus", "for every input", "sky"],
    ["mutation", "1 bug per clause", "Verus must reject", "danger"],
    ["differential", "TS vs WASM", "every input class", "olive"],
    ["receipt", "RECEIPT.md", "shown in Settings", "sand"],
  ];
  const w = 196, gap = 34;
  steps.forEach(([k, title, sub, accent], i) => {
    const x = 32 + i * (w + gap);
    b.push(node(t, { x, y: 80, w, kicker: k, title, sub, accent: accent ?? undefined, strong: !!accent }));
    if (i < steps.length - 1) b.push(edge(t, `M ${x + w} 112 L ${x + w + gap - 6} 112`, accent ?? "lineStrong"), arrow(t, x + w + gap - 6, 112, accent ?? "lineStrong"));
  });
  b.push(label(t, 32, 180, "A negative control (a planted bug built to WASM) proves the differential test can fail.", "muted", "start", 12));
  return frame(t, W, H, b.join("\n"), "Proof-driven development: intent, Verus spec and proof, mutation check, differential test, receipt");
}

const all = { pipeline, swarm, evals, proof };
for (const [name, fn] of Object.entries(all))
  for (const [theme, t] of Object.entries(THEMES)) writeFileSync(join(out, `${name}-${theme}.svg`), fn(t));

// The "ascent" mark from apps/web/src/components/logo.tsx, with the dark theme's colours baked in.
const d = THEMES.dark;
writeFileSync(
  join(out, "logo.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="64" height="64" role="img" aria-label="elevate">
<defs>
  <linearGradient id="g" x1="0" y1="32" x2="32" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${d.olive}"/><stop offset="1" stop-color="${d.sky}"/></linearGradient>
  <linearGradient id="s" x1="16" y1="0" x2="16" y2="32" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity="0.18"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
</defs>
<rect width="32" height="32" rx="9" fill="url(#g)"/>
<rect x="0.5" y="0.5" width="31" height="31" rx="8.5" fill="url(#s)" stroke="#fff" stroke-opacity="0.16"/>
<g fill="none" stroke="${d.bg}" stroke-linecap="round" stroke-linejoin="round" stroke-width="3">
  <path d="M9 21.5 16 14.5 23 21.5" stroke-opacity="0.55"/>
  <path d="M9 15 16 8 23 15"/>
</g>
</svg>
`,
);
console.log(`wrote ${Object.keys(all).length * 2} diagrams and logo.svg to ${out}`);
