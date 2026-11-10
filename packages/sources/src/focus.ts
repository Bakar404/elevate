import type { Fetcher, RawItem } from "./index";

/** What we know about a repo when deciding what to search the web for on its behalf. */
export type FocusRepo = {
  id: string;
  fullName: string;
  language?: string | null;
  topics?: string[];
  pushedAt?: Date | null;
  profile?: { stack: string[]; domains: string[] } | null;
};

export type FocusTermKind = "domain" | "stack" | "topic" | "language";

export type FocusQuery = {
  /** Display form of the term, used verbatim as the search query. */
  term: string;
  kind: FocusTermKind;
  /** Repos this query is searching on behalf of, busiest first. */
  repoIds: string[];
  score: number;
};

export type FocusBackend = "hn" | "arxiv" | "github";

const WEIGHT: Record<FocusTermKind, number> = { domain: 1.2, stack: 1, topic: 0.8, language: 0.3 };

/** Terms so common that searching for them returns noise, not news about this repo. */
const GENERIC = new Set(
  [
    "javascript", "typescript", "python", "html", "css", "json", "yaml", "toml", "markdown", "sql", "shell", "bash", "powershell",
    "git", "github", "github actions", "docker", "docker compose", "node", "node.js", "nodejs", "npm", "pnpm", "yarn", "pip",
    "rest", "rest api", "api", "http", "https", "linux", "windows", "macos", "web", "cli", "eslint", "prettier", "jest", "vitest",
    "unit tests", "testing", "tests", "ci", "ci/cd", "readme", "mit", "license", "frontend", "backend", "web app", "webapp", "app",
    "library", "framework", "tooling", "scripts", "utilities", "misc", "other", "none", "unknown",
  ],
);

export function normalizeTerm(raw: string): string | undefined {
  const t = raw
    .replace(/\([^)]*\)/g, " ")
    .replace(/\bv?\d+(\.\d+)*\b/g, " ")
    .replace(/[`"'*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length < 2 || t.length > 40) return undefined;
  if (t.split(" ").length > 4) return undefined;
  if (!/[a-z]/i.test(t)) return undefined;
  if (GENERIC.has(t.toLowerCase())) return undefined;
  return t;
}

const DAY = 24 * 3600 * 1000;

/**
 * Turn the watched repos into a small set of web searches. Every repo that has any searchable term
 * gets at least one query of its own (round-robin, busiest repo first) before shared terms fill the rest,
 * so a single large stack can't crowd out the others. Terms shared by several repos rank higher and
 * carry all of those repos.
 */
export function buildFocusQueries(repos: FocusRepo[], max = 8, now = Date.now()): FocusQuery[] {
  if (max <= 0) return [];
  const terms = new Map<string, { term: string; kind: FocusTermKind; repos: Map<string, number> }>();
  const activity = new Map<string, number>();
  for (const r of repos) {
    const recent = r.pushedAt && now - r.pushedAt.getTime() < 30 * DAY ? 1.3 : 1;
    activity.set(r.id, recent);
    const add = (raw: string | null | undefined, kind: FocusTermKind) => {
      const term = raw && normalizeTerm(raw);
      if (!term) return;
      const key = term.toLowerCase();
      const entry = terms.get(key) ?? { term, kind, repos: new Map<string, number>() };
      if (WEIGHT[kind] > WEIGHT[entry.kind]) entry.kind = kind;
      entry.repos.set(r.id, Math.max(entry.repos.get(r.id) ?? 0, WEIGHT[kind] * recent));
      terms.set(key, entry);
    };
    for (const d of r.profile?.domains ?? []) add(d, "domain");
    for (const s of r.profile?.stack ?? []) add(s, "stack");
    for (const t of r.topics ?? []) add(t.replace(/-/g, " "), "topic");
    add(r.language, "language");
  }

  const scored = [...terms.entries()].map(([key, e]) => {
    const sum = [...e.repos.values()].reduce((a, b) => a + b, 0);
    const repoIds = [...e.repos.keys()].sort((a, b) => (activity.get(b) ?? 1) - (activity.get(a) ?? 1));
    return { key, query: { term: e.term, kind: e.kind, repoIds, score: Math.round(sum * (1 + 0.15 * (e.repos.size - 1)) * 100) / 100 } };
  });
  scored.sort((a, b) => b.query.score - a.query.score || a.key.localeCompare(b.key));

  const picked = new Map<string, FocusQuery>();
  const order = [...repos].sort((a, b) => (activity.get(b.id) ?? 1) - (activity.get(a.id) ?? 1));
  for (const r of order) {
    if (picked.size >= max) break;
    if ([...picked.values()].some((q) => q.repoIds.includes(r.id) && q.kind !== "language")) continue;
    const best = scored.find((s) => !picked.has(s.key) && s.query.repoIds.includes(r.id));
    if (best) picked.set(best.key, best.query);
  }
  for (const s of scored) {
    if (picked.size >= max) break;
    if (!picked.has(s.key)) picked.set(s.key, s.query);
  }
  return [...picked.values()].sort((a, b) => b.score - a.score);
}

/** Which kinds of term each backend is good at: papers rarely name frameworks, HN and GitHub do. */
export const BACKEND_KINDS: Record<FocusBackend, FocusTermKind[]> = {
  hn: ["domain", "stack", "topic"],
  arxiv: ["domain", "topic"],
  github: ["domain", "stack", "topic"],
};

export function focusUrl(backend: FocusBackend, term: string, now = Date.now()): string {
  const q = encodeURIComponent(term);
  switch (backend) {
    case "hn": {
      const since = Math.floor((now - 30 * DAY) / 1000);
      return `https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=10&query=${q}&numericFilters=created_at_i>${since},points>=15`;
    }
    case "arxiv": {
      const phrase = term.includes(" ") ? `%22${q}%22` : q;
      return `https://export.arxiv.org/api/query?search_query=all:${phrase}&sortBy=submittedDate&sortOrder=descending&max_results=8`;
    }
    case "github": {
      const since = new Date(now - 60 * DAY).toISOString().slice(0, 10);
      return `https://api.github.com/search/repositories?q=${q}+created:%3E${since}+stars:%3E%3D25&sort=stars&order=desc&per_page=8`;
    }
  }
}

type GhRepo = {
  full_name: string;
  html_url: string;
  description: string | null;
  stargazers_count: number;
  created_at: string;
  owner?: { login?: string };
  topics?: string[];
};

export function parseGitHubSearch(body: string): RawItem[] {
  const { items = [] } = JSON.parse(body) as { items?: GhRepo[] };
  return items.map((r) => ({
    externalId: `gh:${r.full_name}`,
    url: r.html_url,
    title: r.description ? `${r.full_name}: ${r.description}` : r.full_name,
    author: r.owner?.login,
    publishedAt: new Date(r.created_at),
    content: [r.description ?? "", r.topics?.length ? `Topics: ${r.topics.join(", ")}` : ""].filter(Boolean).join("\n"),
    signals: { stars: r.stargazers_count },
  }));
}

export type FocusParse = (backend: FocusBackend, body: string) => RawItem[];

/**
 * Run each query against one backend and merge the results. An item found by several queries keeps the
 * first query and the union of their repos. One failing query doesn't sink the sweep; all failing does.
 */
export async function fetchFocused(
  backend: FocusBackend,
  queries: FocusQuery[],
  fetcher: Fetcher,
  parse: FocusParse,
  opts: { pauseMs?: number; now?: number } = {},
): Promise<{ items: RawItem[]; errors: string[] }> {
  const usable = queries.filter((q) => BACKEND_KINDS[backend].includes(q.kind));
  const byUrl = new Map<string, RawItem>();
  const errors: string[] = [];
  for (const [i, q] of usable.entries()) {
    if (i > 0 && opts.pauseMs) await new Promise((r) => setTimeout(r, opts.pauseMs));
    try {
      const res = await fetcher(focusUrl(backend, q.term, opts.now));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      for (const item of parse(backend, await res.text())) {
        if (!item.url || !item.title) continue;
        const seen = byUrl.get(item.url);
        if (seen?.signals?.focus) {
          seen.signals.focus.repoIds = [...new Set([...seen.signals.focus.repoIds, ...q.repoIds])];
          continue;
        }
        byUrl.set(item.url, { ...item, signals: { ...item.signals, focus: { query: q.term, repoIds: [...q.repoIds] } } });
      }
    } catch (err) {
      errors.push(`${q.term}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (usable.length && errors.length === usable.length) throw new Error(`All ${backend} searches failed (${errors[0]})`);
  return { items: [...byUrl.values()], errors };
}
