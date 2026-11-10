import { cancelSwarm } from "@elevate/engine";
import { route } from "@/lib/api";

export const POST = route(async (ctx, _req, { id }) => {
  await cancelSwarm(ctx, id!);
  return { ok: true };
});
