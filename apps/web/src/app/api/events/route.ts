import { eventsSince, recentEvents } from "@elevate/db";
import type { NextRequest } from "next/server";
import { sse } from "@/lib/api";
import { getCtx } from "@/lib/server";

export const dynamic = "force-dynamic";

/** Live activity: the append-only events table, tailed over SSE. `?swarm=` narrows to one swarm. */
export async function GET(req: NextRequest) {
  const ctx = await getCtx();
  const swarmId = req.nextUrl.searchParams.get("swarm") ?? undefined;
  let after = Number(req.nextUrl.searchParams.get("after") ?? req.headers.get("last-event-id") ?? NaN);
  if (!Number.isFinite(after)) {
    const [latest] = await recentEvents(ctx.db, 1);
    after = latest?.id ?? 0;
  }
  return sse(req, async (send, signal) => {
    send({ type: "hello", after });
    let beat = 0;
    while (!signal.aborted) {
      const rows = await eventsSince(ctx.db, after, swarmId);
      for (const e of rows) {
        after = e.id;
        send(e, "event");
      }
      if (++beat % 15 === 0) send({ type: "ping" });
      await new Promise((r) => setTimeout(r, 1000));
    }
  });
}
