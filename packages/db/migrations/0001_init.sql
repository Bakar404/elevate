CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" text DEFAULT 'local' NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" text DEFAULT 'local' NOT NULL,
	"swarm_id" uuid,
	"kind" text NOT NULL,
	"level" text DEFAULT 'info' NOT NULL,
	"message" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT 'local' NOT NULL,
	"source_id" uuid NOT NULL,
	"external_id" text,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"published_at" timestamp with time zone,
	"content" text,
	"signals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"technique_id" uuid,
	"embedding" vector(384),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" text DEFAULT 'local' NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"dedupe_key" text,
	"last_error" text,
	"locked_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT 'local' NOT NULL,
	"technique_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"title" text NOT NULL,
	"hypothesis" jsonb NOT NULL,
	"relevance" real NOT NULL,
	"gate1" jsonb,
	"gate2" jsonb,
	"score" real DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'candidate' NOT NULL,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT 'local' NOT NULL,
	"github_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"language" text,
	"topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"stars" integer DEFAULT 0 NOT NULL,
	"is_private" boolean DEFAULT false NOT NULL,
	"archived" boolean DEFAULT false NOT NULL,
	"fork" boolean DEFAULT false NOT NULL,
	"html_url" text NOT NULL,
	"pushed_at" timestamp with time zone,
	"allow_swarm" boolean DEFAULT false NOT NULL,
	"watch" boolean DEFAULT true NOT NULL,
	"profile" jsonb,
	"profile_text" text,
	"embedding" vector(384),
	"profiled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"tenant_id" text DEFAULT 'local' NOT NULL,
	"name" text NOT NULL,
	"ciphertext" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secrets_tenant_id_name_pk" PRIMARY KEY("tenant_id","name")
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"tenant_id" text DEFAULT 'local' NOT NULL,
	"key" text NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_tenant_id_key_pk" PRIMARY KEY("tenant_id","key")
);
--> statement-breakpoint
CREATE TABLE "sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT 'local' NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credibility" integer DEFAULT 50 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_fetched_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "swarm_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"swarm_id" uuid NOT NULL,
	"key" text NOT NULL,
	"role" text NOT NULL,
	"title" text NOT NULL,
	"instructions" text NOT NULL,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"output" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "swarms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT 'local' NOT NULL,
	"recommendation_id" uuid NOT NULL,
	"repo_id" uuid NOT NULL,
	"executor" text NOT NULL,
	"mode" text DEFAULT 'pr' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"budget" jsonb NOT NULL,
	"branch" text,
	"issue_url" text,
	"pr_url" text,
	"result" jsonb,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "techniques" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT 'local' NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"summary" text NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"claims" jsonb NOT NULL,
	"embedding" vector(384),
	"novelty" real DEFAULT 0.5 NOT NULL,
	"legitimacy" jsonb,
	"legitimacy_score" real,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT 'local' NOT NULL,
	"title" text DEFAULT 'New conversation' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" text DEFAULT 'local' NOT NULL,
	"github_login" text NOT NULL,
	"name" text,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_source_id_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."sources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_technique_id_techniques_id_fk" FOREIGN KEY ("technique_id") REFERENCES "public"."techniques"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarm_tasks" ADD CONSTRAINT "swarm_tasks_swarm_id_swarms_id_fk" FOREIGN KEY ("swarm_id") REFERENCES "public"."swarms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarms" ADD CONSTRAINT "swarms_recommendation_id_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."recommendations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "swarms" ADD CONSTRAINT "swarms_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_swarm" ON "events" USING btree ("swarm_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "items_tenant_url" ON "items" USING btree ("tenant_id","url");--> statement-breakpoint
CREATE INDEX "items_status" ON "items" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "jobs_ready" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_active" ON "jobs" USING btree ("dedupe_key") WHERE "jobs"."status" in ('queued','running') and "jobs"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "messages_thread" ON "messages" USING btree ("thread_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "recommendations_unique" ON "recommendations" USING btree ("tenant_id","technique_id","repo_id");--> statement-breakpoint
CREATE INDEX "recommendations_status" ON "recommendations" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "repos_tenant_full_name" ON "repos" USING btree ("tenant_id","full_name");--> statement-breakpoint
CREATE UNIQUE INDEX "sources_tenant_url" ON "sources" USING btree ("tenant_id","url");--> statement-breakpoint
CREATE UNIQUE INDEX "swarm_tasks_key" ON "swarm_tasks" USING btree ("swarm_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "techniques_tenant_slug" ON "techniques" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_login" ON "users" USING btree ("tenant_id","github_login");