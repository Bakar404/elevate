import { XMLParser } from "fast-xml-parser";
import { parseGitHubSearch, type FocusBackend } from "./focus";

export * from "./focus";

export type RawItem = {
  externalId?: string;
  url: string;
  title: string;
  author?: string;
  publishedAt?: Date;
  content?: string;
  signals?: { points?: number; comments?: number; hnId?: string; stars?: number; focus?: { query: string; repoIds: string[] } };
};

export type SourceDef = {
  kind: "hn" | "rss" | "arxiv" | "github";
  name: string;
  url: string;
  credibility: number;
  config?: Record<string, unknown>;
};

export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const defaultFetch: Fetcher = (url) =>
  fetch(url, { headers: { "user-agent": "elevate/0.1 (+https://github.com/Bakar404/elevate)" }, signal: AbortSignal.timeout(20_000) });

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", textNodeName: "#text" });

function text(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string" || typeof v === "number") return String(v);
  if (Array.isArray(v)) return text(v[0]);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return text(o["#text"] ?? o["@href"] ?? "");
  }
  return "";
}

export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function date(v: string): Date | undefined {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Parse RSS 2.0 or Atom into raw items. */
export function parseFeed(body: string): RawItem[] {
  const doc = xml.parse(body) as Record<string, any>;
  const rssItems = doc.rss?.channel?.item;
  if (rssItems) {
    return (Array.isArray(rssItems) ? rssItems : [rssItems]).map((i: any) => ({
      externalId: text(i.guid) || text(i.link),
      url: text(i.link),
      title: stripHtml(text(i.title)),
      author: text(i["dc:creator"] ?? i.author) || undefined,
      publishedAt: date(text(i.pubDate ?? i["dc:date"])),
      content: stripHtml(text(i["content:encoded"] ?? i.description)).slice(0, 6000),
    }));
  }
  const entries = doc.feed?.entry;
  if (entries) {
    return (Array.isArray(entries) ? entries : [entries]).map((e: any) => {
      const links = Array.isArray(e.link) ? e.link : [e.link];
      const alt = links.find((l: any) => !l?.["@rel"] || l["@rel"] === "alternate") ?? links[0];
      const authors = Array.isArray(e.author) ? e.author : e.author ? [e.author] : [];
      return {
        externalId: text(e.id),
        url: text(alt?.["@href"] ?? alt),
        title: stripHtml(text(e.title)).replace(/\s+/g, " "),
        author: authors.map((a: any) => text(a.name)).filter(Boolean).slice(0, 5).join(", ") || undefined,
        publishedAt: date(text(e.published ?? e.updated)),
        content: stripHtml(text(e.summary ?? e.content)).slice(0, 6000),
      };
    });
  }
  return [];
}

export async function fetchFeed(src: SourceDef, fetcher: Fetcher = defaultFetch): Promise<RawItem[]> {
  const res = await fetcher(src.url);
  if (!res.ok) throw new Error(`${src.name}: HTTP ${res.status}`);
  return parseFeed(await res.text()).filter((i) => i.url && i.title);
}

type HnHit = {
  objectID: string;
  title: string | null;
  url: string | null;
  author: string;
  points: number | null;
  num_comments: number | null;
  created_at: string;
  story_text?: string | null;
};

export function parseHackerNews(body: string): RawItem[] {
  const { hits = [] } = JSON.parse(body) as { hits?: HnHit[] };
  return hits
    .filter((h) => h.title)
    .map((h) => ({
      externalId: `hn:${h.objectID}`,
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      title: h.title!,
      author: h.author,
      publishedAt: date(h.created_at),
      content: h.story_text ? stripHtml(h.story_text).slice(0, 4000) : undefined,
      signals: { points: h.points ?? 0, comments: h.num_comments ?? 0, hnId: h.objectID },
    }));
}

/** Hacker News via the Algolia API; `url` is the full search URL (points filter etc.). */
export async function fetchHackerNews(src: SourceDef, fetcher: Fetcher = defaultFetch): Promise<RawItem[]> {
  const res = await fetcher(src.url);
  if (!res.ok) throw new Error(`${src.name}: HTTP ${res.status}`);
  return parseHackerNews(await res.text());
}

/** Parse a focused-search response from any backend. */
export function parseFocusResponse(backend: FocusBackend, body: string): RawItem[] {
  switch (backend) {
    case "hn":
      return parseHackerNews(body);
    case "arxiv":
      return parseFeed(body);
    case "github":
      return parseGitHubSearch(body);
  }
}

/** Focused sources have no fixed URL: their queries are built from the watched repos on every sweep. */
export const FOCUS_SCHEME = "focus://";
export function focusBackend(url: string): FocusBackend | undefined {
  if (!url.startsWith(FOCUS_SCHEME)) return undefined;
  const b = url.slice(FOCUS_SCHEME.length);
  return b === "hn" || b === "arxiv" || b === "github" ? b : undefined;
}

export { defaultFetch };
/** HN discussion signal for an arbitrary URL or phrase (used by the legitimacy gate). */
export async function hackerNewsSignal(query: string, fetcher: Fetcher = defaultFetch) {
  const url = `https://hn.algolia.com/api/v1/search?tags=story&hitsPerPage=10&query=${encodeURIComponent(query)}`;
  const res = await fetcher(url);
  if (!res.ok) return { stories: 0, points: 0, comments: 0, top: [] as { title: string; url: string; points: number }[] };
  const body = JSON.parse(await res.text()) as { hits: HnHit[]; nbHits: number };
  return {
    stories: body.nbHits,
    points: body.hits.reduce((s, h) => s + (h.points ?? 0), 0),
    comments: body.hits.reduce((s, h) => s + (h.num_comments ?? 0), 0),
    top: body.hits.slice(0, 3).map((h) => ({
      title: h.title ?? "",
      url: `https://news.ycombinator.com/item?id=${h.objectID}`,
      points: h.points ?? 0,
    })),
  };
}

export async function fetchSource(src: SourceDef, fetcher?: Fetcher): Promise<RawItem[]> {
  switch (src.kind) {
    case "hn":
      return fetchHackerNews(src, fetcher);
    case "rss":
    case "arxiv":
      return fetchFeed(src, fetcher);
    case "github":
      throw new Error(`${src.name}: GitHub sources are focused-only`);
  }
}

const day = () => Math.floor(Date.now() / 1000) - 3 * 24 * 3600;

export function defaultSources(): SourceDef[] {
  return [
    {
      kind: "hn",
      name: "Hacker News (100+ points)",
      url: `https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=60&numericFilters=points>100,created_at_i>${day()}`,
      credibility: 45,
    },
    { kind: "rss", name: "OpenAI News", url: "https://openai.com/news/rss.xml", credibility: 85 },
    { kind: "rss", name: "Google DeepMind", url: "https://deepmind.google/blog/rss.xml", credibility: 85 },
    { kind: "rss", name: "Google Research", url: "https://research.google/blog/rss/", credibility: 85 },
    { kind: "rss", name: "Microsoft Research", url: "https://www.microsoft.com/en-us/research/feed/", credibility: 80 },
    { kind: "rss", name: "Hugging Face Blog", url: "https://huggingface.co/blog/feed.xml", credibility: 75 },
    { kind: "rss", name: "GitHub Blog", url: "https://github.blog/feed/", credibility: 75 },
    { kind: "rss", name: "Simon Willison", url: "https://simonwillison.net/atom/everything/", credibility: 70 },
    {
      kind: "arxiv",
      name: "arXiv cs.SE / cs.PL / cs.LG",
      url: "https://export.arxiv.org/api/query?search_query=cat:cs.SE+OR+cat:cs.PL+OR+cat:cs.LG&sortBy=submittedDate&sortOrder=descending&max_results=60",
      credibility: 60,
    },
    // Searched with terms from your repos' profiles on every sweep.
    { kind: "hn", name: "Hacker News · for your repos", url: `${FOCUS_SCHEME}hn`, credibility: 45, config: { focus: true } },
    { kind: "arxiv", name: "arXiv · for your repos", url: `${FOCUS_SCHEME}arxiv`, credibility: 60, config: { focus: true } },
    { kind: "github", name: "New on GitHub · for your repos", url: `${FOCUS_SCHEME}github`, credibility: 50, config: { focus: true } },
  ];
}

/** HN query URLs embed a time window; refresh it on every sweep. */
export function refreshSourceUrl(src: SourceDef): string {
  if (src.kind === "hn" && src.url.includes("created_at_i>")) {
    return src.url.replace(/created_at_i>\d+/, `created_at_i>${day()}`);
  }
  return src.url;
}
