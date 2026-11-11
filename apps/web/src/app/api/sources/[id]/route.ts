import { audit } from "@elevate/db";
import { removeSource, updateSource } from "@elevate/engine";
import { z } from "zod";
import { body, route } from "@/lib/api";

const Patch = z.object({ enabled: z.boolean(), credibility: z.number().int().min(0).max(100) }).partial();

export const PATCH = route(async (ctx, req, { id }) => {
  const p = Patch.parse(await body(req));
  const row = await updateSource(ctx, id!, p);
  await audit(ctx.db, "user", "source.update", row.url, p);
  return row;
});

export const DELETE = route(async (ctx, _req, { id }) => {
  const out = await removeSource(ctx, id!);
  await audit(ctx.db, "user", "source.remove", id!, {});
  return out;
});
