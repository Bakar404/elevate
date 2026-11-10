import { enqueue } from "@elevate/db";
import { route } from "@/lib/api";

export const POST = route(async (ctx) => {
  if (ctx.demo) return { queued: false, message: "Demo mode uses three sample repos." };
  await enqueue(ctx.db, "repos.sync", {}, { dedupeKey: "repos.sync" });
  return { queued: true };
});
