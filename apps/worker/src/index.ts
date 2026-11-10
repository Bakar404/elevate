import { stopCopilotClient } from "@elevate/agent";
import { defaultCtx, seedDemo, startWorker } from "@elevate/engine";

/**
 * Standalone worker: runs ingestion, matching, both gates and swarms outside the web process.
 * Run the web app with ELEVATE_EMBEDDED_WORKER=0 when using this, against the same DATABASE_URL.
 * With the embedded PGlite store only one process can open the data dir, so use Postgres here.
 */
const ctx = await defaultCtx();
if (ctx.demo) await seedDemo(ctx);
const worker = startWorker(ctx, {
  pollMs: Number(process.env.ELEVATE_WORKER_POLL_MS ?? 1500),
  maxSwarms: Number(process.env.ELEVATE_MAX_SWARMS ?? 2),
});
console.log(`elevate worker started${ctx.demo ? " (demo)" : ""}`);

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: draining…`);
  await worker.stop();
  await stopCopilotClient().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
