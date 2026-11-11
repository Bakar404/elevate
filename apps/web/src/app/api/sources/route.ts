import { audit } from "@elevate/db";
import { addSource, listSources } from "@elevate/engine";
import { z } from "zod";
import { body, route } from "@/lib/api";

export const dynamic = "force-dynamic";

export const GET = route((ctx) => listSources(ctx));

const Post = z.object({ name: z.string().trim().min(1).max(80), url: z.string().url().max(500), credibility: z.number().int().min(0).max(100).optional() });

export const POST = route(async (ctx, req) => {
  const p = Post.parse(await body(req));
  const row = await addSource(ctx, p);
  await audit(ctx.db, "user", "source.add", row.url, { name: row.name });
  return row;
});
