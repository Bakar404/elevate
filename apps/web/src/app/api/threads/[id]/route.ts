import { deleteThread, setThreadModel, threadMessages } from "@elevate/engine";
import { NextResponse } from "next/server";
import { z } from "zod";
import { body, route } from "@/lib/api";

export const dynamic = "force-dynamic";

const Patch = z.object({ model: z.string().max(100).nullable() });

export const GET = route((ctx, _req, { id }) => threadMessages(ctx, id!));
export const PATCH = route(async (ctx, req, { id }) => {
  const p = Patch.parse(await body(req));
  const t = await setThreadModel(ctx, id!, p.model);
  return t ?? NextResponse.json({ error: "Conversation not found" }, { status: 404 });
});
export const DELETE = route((ctx, _req, { id }) => deleteThread(ctx, id!));