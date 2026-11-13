ALTER TABLE "items" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;