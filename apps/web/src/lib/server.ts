import { defaultCtx, seedDemo, startWorker, type Ctx, type WorkerHandle } from "@elevate/engine";

const KEY = Symbol.for("elevate.web");
type State = { ctx?: Promise<Ctx>; worker?: WorkerHandle };

function state(): State {
  const g = globalThis as typeof globalThis & { [KEY]?: State };
  return (g[KEY] ??= {});
}

/** One engine context per server process; starts the embedded worker unless it runs separately. */
export function getCtx(): Promise<Ctx> {
  const s = state();
  s.ctx ??= (async () => {
    const ctx = await defaultCtx();
    if (ctx.demo) await seedDemo(ctx);
    if (process.env.ELEVATE_EMBEDDED_WORKER !== "0") s.worker ??= startWorker(ctx, { pollMs: 1500 });
    return ctx;
  })().catch((err) => {
    s.ctx = undefined;
    throw err;
  });
  return s.ctx;
}

/** Wake the embedded worker after enqueueing work from a request. */
export function kick() {
  state().worker?.kick();
}
