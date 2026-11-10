/**
 * Repo search for the Repos page. Every query word has to hit somewhere (name, stack, domain, topic,
 * language, module, summary or description); results are ranked by where the hits are, so
 * "postgres" puts repos built on Postgres above ones that merely mention it.
 */
export type SearchableRepo = {
  fullName: string;
  description: string | null;
  language: string | null;
  topics: string[];
  profile: { summary: string; stack: string[]; domains: string[]; keyModules: { path: string; purpose: string }[]; improvementSurfaces: string[] } | null;
};

const FIELD_WEIGHT = { name: 6, stack: 5, domain: 4, topic: 4, language: 3, module: 2, surface: 2, text: 1 } as const;
type Field = keyof typeof FIELD_WEIGHT;

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
const words = (q: string) => [...new Set(norm(q).split(/[\s,]+/).filter(Boolean))];

function fields(r: SearchableRepo): [Field, string][] {
  const p = r.profile;
  return [
    ["name", r.fullName],
    ...(p?.stack ?? []).map((s) => ["stack", s] as [Field, string]),
    ...(p?.domains ?? []).map((s) => ["domain", s] as [Field, string]),
    ...r.topics.map((s) => ["topic", s] as [Field, string]),
    ...(r.language ? [["language", r.language] as [Field, string]] : []),
    ...(p?.keyModules ?? []).map((m) => ["module", `${m.path} ${m.purpose}`] as [Field, string]),
    ...(p?.improvementSurfaces ?? []).map((s) => ["surface", s] as [Field, string]),
    ["text", `${p?.summary ?? ""} ${r.description ?? ""}`],
  ];
}

/** 0 means no match. Exact field matches beat prefix matches beat substring matches. */
export function repoScore(r: SearchableRepo, query: string): number {
  const qs = words(query);
  if (!qs.length) return 1;
  const fs = fields(r).map(([f, v]) => [f, norm(v)] as const);
  let total = 0;
  for (const w of qs) {
    let best = 0;
    for (const [f, v] of fs) {
      if (!v.includes(w)) continue;
      const exact = v === w || v.split(/[^a-z0-9.+#]+/).includes(w);
      const prefix = !exact && new RegExp(`(^|[^a-z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(v);
      best = Math.max(best, FIELD_WEIGHT[f] * (exact ? 3 : prefix ? 2 : 1));
    }
    if (!best) return 0;
    total += best;
  }
  return total;
}

/** Stable: equal scores keep the input order (most recently pushed first on the Repos page). */
export function searchRepos<T extends SearchableRepo>(rows: T[], query: string): T[] {
  if (!words(query).length) return rows;
  return rows
    .map((r, i) => ({ r, i, s: repoScore(r, query) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.r);
}
