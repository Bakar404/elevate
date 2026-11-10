import { enqueue } from "@elevate/db";
import { route } from "@/lib/api";

export const POST = route(async (ctx) => {
  if (ctx.demo) return { queued: false, message: "Demo mode is offline; the radar uses sample items." };
  await enqueue(ctx.db, "sources.sweep", {}, { dedupeKey: "sources.sweep" });
  return { queued: true };
});
