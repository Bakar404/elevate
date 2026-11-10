import { chat } from "@elevate/engine";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { sameOrigin, sse } from "@/lib/api";
import { getCtx } from "@/lib/server";

export const dynamic = "force-dynamic";

const Body = z.object({ threadId: z.string().uuid(), prompt: z.string().min(1).max(8000) });

export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) return NextResponse.json({ error: "Cross-origin request refused" }, { status: 403 });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "threadId and prompt are required" }, { status: 400 });
  const ctx = await getCtx();
  return sse(req, async (send, signal) => {
    await chat(ctx, parsed.data.threadId, parsed.data.prompt, (e) => send(e), signal);
  });
}
