ALTER TABLE "recommendations" ADD COLUMN "feedback" smallint;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN "feedback_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "techniques" ADD COLUMN "frontier" boolean;