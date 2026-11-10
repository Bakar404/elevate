import { threadMessages } from "@elevate/engine";
import { eq, threads } from "@elevate/db";
import { forgetThread } from "@elevate/agent";
import { route } from "@/lib/api";

export const dynamic = "force-dynamic";
export const GET = route((ctx, _req, { id }) => threadMessages(ctx, id!));
export const DELETE = route(async (ctx, _req, { id }) => {
  forgetThread(id!);
  await ctx.db.delete(threads).where(eq(threads.id, id!));
  return { ok: true };
});
