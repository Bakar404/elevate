/**
 * Which AI ecosystem a piece of news belongs to, which model versions it is about, and whether the
 * person reading it can act on it. Pure functions: the engine supplies what the user has connected.
 *
 * Nothing here lists "current" models. What counts as current is derived at run time from the user's
 * live model list and from the versions seen in incoming news, so it can't go stale with the code.
 */

export const ECOSYSTEMS = ["copilot", "openai", "codex", "anthropic", "claude-code", "google", "xai"] as const;
export type Ecosystem = (typeof ECOSYSTEMS)[number];

export const ECOSYSTEM_LABEL: Record<Ecosystem, string> = {
  copilot: "GitHub Copilot",
  openai: "OpenAI models",
  codex: "Codex",
  anthropic: "Claude models",
  "claude-code": "Claude Code",
  google: "Gemini models",
  xai: "Grok models",
};

/** A product implies its vendor: news that needs Codex is OpenAI news. */
const PARENT: Partial<Record<Ecosystem, Ecosystem>> = { codex: "openai", "claude-code": "anthropic" };
const group = (e: Ecosystem): Ecosystem => PARENT[e] ?? e;

export function isEcosystem(v: unknown): v is Ecosystem {
  return typeof v === "string" && (ECOSYSTEMS as readonly string[]).includes(v);
}

const DETECT: [Ecosystem, RegExp][] = [
  ["copilot", /\bcopilot\b/i],
  ["codex", /\bcodex\b/i],
  ["openai", /\bopen\s?ai\b|\bchatgpt\b|\bgpt[- ]?\d/i],
  ["claude-code", /\bclaude[- ]code\b/i],
  ["anthropic", /\banthropic\b|\bclaude\b/i],
  ["google", /\bgemini\b|\bvertex ai\b|\bgoogle ai studio\b/i],
  ["xai", /\bgrok\b|\bxai\b/i],
];

/** Every ecosystem a text names. A product hides its vendor ("Claude Code" → claude-code, not also anthropic). */
export function detectEcosystems(text: string): Ecosystem[] {
  const found = DETECT.filter(([, re]) => re.test(text)).map(([e]) => e);
  return found.filter((e) => !found.some((other) => PARENT[other] === e));
}

export type ModelRef = {
  /** Version line that supersedes itself: "gpt", "claude-opus", "claude" (tier not named), "gemini", "grok". */
  family: string;
  version: number[];
  /** Size or tier suffix when one was written with the id, e.g. "mini", "sol". */
  variant?: string;
  ecosystem: Ecosystem;
  label: string;
};

const TIERS = "opus|sonnet|haiku|fable|mythos";
const SIZE = "mini|nano|pro|turbo|max|flash|ultra|lite";
const MODEL_RES: { re: RegExp; build: (m: RegExpExecArray) => Omit<ModelRef, "label"> | undefined }[] = [
  {
    // gpt-5.4, GPT 5.4, gpt-6.1-sol, GPT-5 mini
    re: new RegExp(`\\bgpt[- ]?(\\d+(?:\\.\\d+)?)(?:-([a-z]+)|\\s(${SIZE})\\b)?`, "gi"),
    build: (m) => ({ family: "gpt", version: ver(m[1]!), variant: (m[2] ?? m[3])?.toLowerCase(), ecosystem: "openai" }),
  },
  {
    // Claude Opus 4.7, claude-sonnet-5.5, claude-opus-4-7, Claude 3.5 Sonnet, Claude 4
    re: new RegExp(`\\bclaude[- ]?(?:(${TIERS})[- ]?)?(\\d+(?:[.-]\\d{1,2})?)(?![\\d.])(?:[- ](${TIERS})\\b)?`, "gi"),
    build: (m) => {
      const tier = (m[1] ?? m[3])?.toLowerCase();
      return { family: tier ? `claude-${tier}` : "claude", version: ver(m[2]!), ecosystem: "anthropic" };
    },
  },
  {
    re: new RegExp(`\\bgemini[- ]?(\\d+(?:\\.\\d+)?)(?:-([a-z]+)|\\s(${SIZE})\\b)?`, "gi"),
    build: (m) => ({ family: "gemini", version: ver(m[1]!), variant: (m[2] ?? m[3])?.toLowerCase(), ecosystem: "google" }),
  },
  {
    re: /\bgrok[- ]?(\d+(?:\.\d+)?)/gi,
    build: (m) => ({ family: "grok", version: ver(m[1]!), ecosystem: "xai" }),
  },
];

function ver(s: string): number[] {
  return s.split(/[.-]/).map(Number);
}

const FAMILY_NAME: Record<string, string> = { gpt: "GPT", gemini: "Gemini", grok: "Grok", claude: "Claude" };
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function modelLabel(m: Pick<ModelRef, "family" | "version" | "variant">): string {
  const v = m.version.join(".");
  if (m.family.startsWith("claude-")) return `Claude ${cap(m.family.slice(7))} ${v}`;
  const base = m.family === "gpt" ? `GPT-${v}` : `${FAMILY_NAME[m.family] ?? cap(m.family)} ${v}`;
  return m.variant ? `${base} ${cap(m.variant)}` : base;
}

/** Model versions named in a text (ids like `gpt-6.1-sol` or prose like "Claude Opus 4.7"), de-duplicated. */
export function findModels(text: string): ModelRef[] {
  const out = new Map<string, ModelRef>();
  for (const { re, build } of MODEL_RES) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const ref = build(m);
      if (!ref || ref.version.some(Number.isNaN)) continue;
      const full = { ...ref, label: modelLabel(ref) };
      out.set(`${full.family}@${full.version.join(".")}@${full.variant ?? ""}`, full);
    }
  }
  return [...out.values()];
}

export function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** "claude" (no tier named) is the same line as every Claude tier; otherwise families must match. */
function sameLine(a: string, b: string) {
  return a === b || (a === "claude" && b.startsWith("claude")) || (b === "claude" && a.startsWith("claude"));
}

const sameVersion = (a: ModelRef, b: ModelRef) => sameLine(a.family, b.family) && compareVersions(a.version, b.version) === 0;

export type TechniqueTags = {
  /** The technique can only be adopted with access to one of these; empty = works with anything. */
  requires: Ecosystem[];
  /** Model versions the technique is about. */
  models: ModelRef[];
};

/**
 * Tags for a technique that was stored without them (or for the offline model): a technique whose
 * name is about exactly one vendor is tied to that vendor; one that names several is a comparison.
 */
export function inferTags(name: string, summary = ""): TechniqueTags {
  let found = detectEcosystems(name);
  if (!found.length) found = detectEcosystems(summary);
  const groups = new Set(found.map(group));
  return { requires: groups.size === 1 ? found : [], models: findModels(name) };
}

/** Tags from what triage stored on the technique, falling back to inference for older rows. */
export function techniqueTags(t: { name: string; summary?: string; claims?: { requires?: string[]; models?: string[] } | null }): TechniqueTags {
  const inferred = inferTags(t.name, t.summary);
  const stored = t.claims?.requires;
  const models = new Map<string, ModelRef>();
  for (const m of [...findModels((t.claims?.models ?? []).join("\n")), ...inferred.models]) models.set(m.label, m);
  return { requires: stored ? stored.filter(isEcosystem) : inferred.requires, models: [...models.values()] };
}

export type Access = {
  /** What the user has connected or said they have. */
  ecosystems: Ecosystem[];
  /** The exact models the user's plan offers, when the provider can list them (Copilot). Empty = unknown. */
  available: ModelRef[];
  /** Every model version seen so far (the plan's list plus incoming news); used to spot superseded versions. */
  known: ModelRef[];
};

export type AccessVerdict =
  | { usable: true }
  | { usable: false; kind: "superseded" | "no-access" | "not-on-plan"; reason: string };

/** The newest known version on the same line, if it is newer than `m`. */
export function supersededBy(m: ModelRef, access: Pick<Access, "available" | "known">): ModelRef | undefined {
  if (access.available.some((a) => sameVersion(a, m))) return undefined;
  let newest: ModelRef | undefined;
  for (const k of [...access.available, ...access.known]) {
    if (!sameLine(k.family, m.family) || compareVersions(k.version, m.version) <= 0) continue;
    if (!newest || compareVersions(k.version, newest.version) > 0) newest = k;
  }
  return newest;
}

const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}`);

/**
 * Can this user act on the technique? Not when it is about a model version that has been replaced,
 * needs a product they haven't connected, or names models their plan doesn't offer.
 */
export function judgeAccess(tags: TechniqueTags, access: Access): AccessVerdict {
  if (tags.models.length) {
    const replaced = tags.models.map((m) => ({ m, by: supersededBy(m, access) }));
    if (replaced.every((r) => r.by)) {
      const { m, by } = replaced[0]!;
      return { usable: false, kind: "superseded", reason: `${m.label} has been superseded by ${by!.label}` };
    }
  }
  const have = new Set(access.ecosystems);
  if (tags.requires.length && !tags.requires.some((e) => have.has(e))) {
    return { usable: false, kind: "no-access", reason: `Needs ${list(tags.requires.map((e) => ECOSYSTEM_LABEL[e]))}, which you haven't connected` };
  }
  if (access.available.length && tags.models.length) {
    // Only models from vendors the plan's list actually covers can be "missing" from it.
    const covered = new Set(access.available.map((a) => a.ecosystem));
    const live = tags.models.filter((m) => !supersededBy(m, access));
    if (live.length && live.every((m) => covered.has(m.ecosystem)) && !live.some((m) => access.available.some((a) => sameVersion(a, m)))) {
      return { usable: false, kind: "not-on-plan", reason: `${list(live.map((m) => m.label))} isn't in your plan's model list` };
    }
  }
  return { usable: true };
}
