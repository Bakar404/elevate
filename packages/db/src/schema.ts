import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

export const EMBEDDING_DIM = 384;

const tenantId = () => text("tenant_id").notNull().default("local");
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    githubLogin: text("github_login").notNull(),
    name: text("name"),
    avatarUrl: text("avatar_url"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("users_tenant_login").on(t.tenantId, t.githubLogin)],
);

/** Encrypted secrets (GitHub token, BYOK provider keys). */
export const secrets = pgTable(
  "secrets",
  {
    tenantId: tenantId(),
    name: text("name").notNull(),
    ciphertext: text("ciphertext").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.name] })],
);

export const settings = pgTable(
  "settings",
  {
    tenantId: tenantId(),
    key: text("key").notNull(),
    value: jsonb("value").notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.key] })],
);

export type RepoProfile = {
  summary: string;
  stack: string[];
  domains: string[];
  keyModules: { path: string; purpose: string }[];
  testSetup: string;
  improvementSurfaces: string[];
};

export const repos = pgTable(
  "repos",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    githubId: bigint("github_id", { mode: "number" }).notNull(),
    fullName: text("full_name").notNull(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    defaultBranch: text("default_branch").notNull().default("main"),
    language: text("language"),
    topics: jsonb("topics").$type<string[]>().notNull().default([]),
    stars: integer("stars").notNull().default(0),
    isPrivate: boolean("is_private").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    fork: boolean("fork").notNull().default(false),
    htmlUrl: text("html_url").notNull(),
    pushedAt: timestamp("pushed_at", { withTimezone: true }),
    /** Swarms may only write to repos on the allow-list. */
    allowSwarm: boolean("allow_swarm").notNull().default(false),
    /** Watched repos are profiled and receive recommendations. */
    watch: boolean("watch").notNull().default(true),
    profile: jsonb("profile").$type<RepoProfile>(),
    profileText: text("profile_text"),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIM }),
    profiledAt: timestamp("profiled_at", { withTimezone: true }),
    /** Default-branch head at the last sync, and the commit the current profile was built from. */
    headSha: text("head_sha"),
    profiledSha: text("profiled_sha"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("repos_tenant_full_name").on(t.tenantId, t.fullName)],
);

export type SourceKind = "hn" | "rss" | "arxiv" | "github";

export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    kind: text("kind").$type<SourceKind>().notNull(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    /** Prior credibility of the outlet, 0-100. Used by the legitimacy gate. */
    credibility: integer("credibility").notNull().default(50),
    enabled: boolean("enabled").notNull().default(true),
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("sources_tenant_url").on(t.tenantId, t.url)],
);

export type ItemSignals = {
  points?: number;
  comments?: number;
  hnId?: string;
  stars?: number;
  /** Set when the item was found by a search built from these repos' profiles. */
  focus?: { query: string; repoIds: string[] };
};

export const items = pgTable(
  "items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    externalId: text("external_id"),
    url: text("url").notNull(),
    title: text("title").notNull(),
    author: text("author"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    content: text("content"),
    signals: jsonb("signals").$type<ItemSignals>().notNull().default({}),
    /** new -> triaged (technique linked) | irrelevant */
    status: text("status").$type<"new" | "triaged" | "irrelevant" | "error">().notNull().default("new"),
    techniqueId: uuid("technique_id"),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIM }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("items_tenant_url").on(t.tenantId, t.url),
    index("items_status").on(t.tenantId, t.status),
  ],
);

export type TechniqueClaims = {
  claimedBenefits: string[];
  appliesTo: string[];
  prerequisites: string[];
  evidenceLinks: string[];
  /** AI ecosystems the technique is tied to (see @elevate/sources `Ecosystem`). Empty = works with anything; absent = stored before tagging. */
  requires?: string[];
  /** Model versions the technique is about, as written (e.g. "GPT-6.1", "Claude Opus 5.5"). */
  models?: string[];
};

export type GateResult = {
  passed: boolean;
  score: number;
  verdict: string;
  reasons: string[];
  evidence: { label: string; detail: string; url?: string; weight?: number }[];
  checkedAt: string;
};

/** A technique is a de-duplicated "new thing" that one or more items describe. */
export const techniques = pgTable(
  "techniques",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    summary: text("summary").notNull(),
    category: text("category").notNull().default("other"),
    claims: jsonb("claims").$type<TechniqueClaims>().notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIM }),
    novelty: real("novelty").notNull().default(0.5),
    legitimacy: jsonb("legitimacy").$type<GateResult>(),
    legitimacyScore: real("legitimacy_score"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("techniques_tenant_slug").on(t.tenantId, t.slug)],
);

export type Hypothesis = {
  change: string;
  rationale: string;
  expectedImpact: string;
  effort: "S" | "M" | "L";
  risk: "low" | "medium" | "high";
  touchpoints: string[];
};

export type RecommendationStatus =
  | "candidate"
  | "gated_out"
  | "open"
  | "approved"
  | "rejected"
  | "in_progress"
  | "pr_opened"
  | "failed"
  | "merged"
  | "closed";

/** Mirrors `LifecycleEvent` in @elevate/policy (kept here so db has no deps). */
export type RecommendationEvent =
  | "gate_pass"
  | "gate_fail"
  | "approve"
  | "reject"
  | "start"
  | "pr"
  | "fail"
  | "retry"
  | "regate"
  | "reopen"
  | "merge"
  | "close";

export const recommendations = pgTable(
  "recommendations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: tenantId(),
    techniqueId: uuid("technique_id")
      .notNull()
      .references(() => techniques.id, { onDelete: "cascade" }),
    repoId: uuid("repo_id")
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    hypothesis: jsonb("hypothesis").$type<Hypothesis>().notNull(),
    relevance: real("relevance").notNull(),
    gate1: jsonb("gate1").$type<GateResult>(),
    gate2: jsonb("gate2").$type<GateResult>(),
    score: real("score").notNull().default(0),
    status: text("status").$type<RecommendationStatus>().notNull().default("candidate"),
    /** Every lifecycle event applied, in order. `replay(history)` must equal `status` (T7). */
    history: jsonb("history").$type<RecommendationEvent[]>().notNull().default([]),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("recommendations_unique").on(t.tenantId, t.techniqueId, t.repoId),
    index("recommendations_status").on(t.tenantId, t.status),
  ],
);

export type ExecutorKind = "copilot-cloud" | "claude-action" | "codex-cloud" | "local" | "fake";

export type SwarmBudget = { maxTasks: number; maxMinutes: number; maxAgentTurns: number };

export type SwarmStatus = "queued" | "planning" | "running" | "succeeded" | "failed" | "cancelled";

export const swarms = pgTable("swarms", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: tenantId(),
  recommendationId: uuid("recommendation_id")
    .notNull()
    .references(() => recommendations.id, { onDelete: "cascade" }),
  repoId: uuid("repo_id")
    .notNull()
    .references(() => repos.id, { onDelete: "cascade" }),
  executor: text("executor").$type<ExecutorKind>().notNull(),
  mode: text("mode").$type<"pr" | "spike">().notNull().default("pr"),
  status: text("status").$type<SwarmStatus>().notNull().default("queued"),
  budget: jsonb("budget").$type<SwarmBudget>().notNull(),
  branch: text("branch"),
  issueUrl: text("issue_url"),
  prUrl: text("pr_url"),
  result: jsonb("result").$type<Record<string, unknown>>(),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export type TaskRole = "planner" | "implementer" | "tester" | "reviewer" | "publisher";
export type TaskStatus = "pending" | "running" | "done" | "failed" | "skipped";

export const swarmTasks = pgTable(
  "swarm_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    swarmId: uuid("swarm_id")
      .notNull()
      .references(() => swarms.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    role: text("role").$type<TaskRole>().notNull(),
    title: text("title").notNull(),
    instructions: text("instructions").notNull(),
    dependsOn: jsonb("depends_on").$type<string[]>().notNull().default([]),
    status: text("status").$type<TaskStatus>().notNull().default("pending"),
    output: text("output"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("swarm_tasks_key").on(t.swarmId, t.key)],
);

/** Append-only activity stream; powers the live feed and SSE progress. */
export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenantId: tenantId(),
    swarmId: uuid("swarm_id"),
    kind: text("kind").notNull(),
    level: text("level").$type<"info" | "success" | "warn" | "error">().notNull().default("info"),
    message: text("message").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index("events_swarm").on(t.swarmId, t.id)],
);

/** Every externally visible write (issue, branch, PR, setting change) is audited. */
export const auditLog = pgTable("audit_log", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  tenantId: tenantId(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  target: text("target").notNull(),
  details: jsonb("details").$type<Record<string, unknown>>(),
  createdAt: createdAt(),
});

export type JobStatus = "queued" | "running" | "done" | "failed";

export const jobs = pgTable(
  "jobs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenantId: tenantId(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: text("status").$type<JobStatus>().notNull().default("queued"),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    dedupeKey: text("dedupe_key"),
    lastError: text("last_error"),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("jobs_ready").on(t.status, t.runAt),
    uniqueIndex("jobs_dedupe_active")
      .on(t.dedupeKey)
      .where(sql`${t.status} in ('queued','running') and ${t.dedupeKey} is not null`),
  ],
);

export const threads = pgTable("threads", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: tenantId(),
  title: text("title").notNull().default("New conversation"),
  /** Model picked for this conversation; null follows the chat default in Settings. */
  model: text("model"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export type ToolCallRecord = { name: string; args?: unknown; result?: string };

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    role: text("role").$type<"user" | "assistant">().notNull(),
    content: text("content").notNull(),
    toolCalls: jsonb("tool_calls").$type<ToolCallRecord[]>().notNull().default([]),
    createdAt: createdAt(),
  },
  (t) => [index("messages_thread").on(t.threadId, t.createdAt)],
);
