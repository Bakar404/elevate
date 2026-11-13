import { enqueue } from "@elevate/db";
import { retryFailedTriage } from "@elevate/engine";
import { route } from "@/lib/api";

export const POST = route(async (ctx) => {
  if (ctx.demo) return { queued: false, message: "Demo mode is offline; the radar uses sample items." };
  // The user asked for a sweep: retry every item whose triage failed, including ones out of tries.
  const retried = await retryFailedTriage(ctx, "local", { all: true });
  await enqueue(ctx.db, "sources.sweep", {}, { dedupeKey: "sources.sweep" });
  return { queued: true, retried };
});
