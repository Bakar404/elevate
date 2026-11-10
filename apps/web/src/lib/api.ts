import { ApprovalError, LifecycleError, type Ctx } from "@elevate/engine";
import { WriteRefused } from "@elevate/policy";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError } from "zod";
import { getCtx, kick } from "./server";

type Params = Record<string, string>;
type Handler = (ctx: Ctx, req: NextRequest, params: Params) => Promise<unknown>;

/**
 * Local-first means no login yet, so the only thing standing between another website and
 * "approve a swarm" is the browser's Origin header. Mutating requests must come from this app.
 */
export function sameOrigin(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (!origin) return req.headers.get("sec-fetch-site") !== "cross-site";
  return origin === req.nextUrl.origin || origin === `${req.nextUrl.protocol}//${req.headers.get("host")}`;
}

export function route(handler: Handler) {
  return async (req: NextRequest, { params }: { params: Promise<Params> }) => {
    if (req.method !== "GET" && !sameOrigin(req)) return NextResponse.json({ error: "Cross-origin request refused" }, { status: 403 });
    try {
      const ctx = await getCtx();
      const out = await handler(ctx, req, await params);
      if (req.method !== "GET") kick();
      return out instanceof Response ? out : NextResponse.json(out ?? { ok: true });
    } catch (err) {
      const status =
        err instanceof ZodError ? 400 : err instanceof ApprovalError || err instanceof LifecycleError ? 409 : err instanceof WriteRefused ? 403 : 500;
      const message = err instanceof ZodError ? err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : err instanceof Error ? err.message : String(err);
      if (status === 500) console.error(err);
      return NextResponse.json({ error: message }, { status });
    }
  };
}

export const body = async (req: NextRequest) => (await req.json().catch(() => ({}))) as unknown;

/** Server-Sent Events response from an async producer. */
export function sse(req: NextRequest, produce: (send: (data: unknown, event?: string) => void, signal: AbortSignal) => Promise<void>) {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      const send = (data: unknown, event?: string) => {
        if (!open) return;
        controller.enqueue(enc.encode(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`));
      };
      try {
        await produce(send, req.signal);
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
      } finally {
        open = false;
        try {
          controller.close();
        } catch {}
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" } });
}
