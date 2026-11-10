/**
 * Smoke test for the model runtime: one structured call through the Copilot SDK (your Copilot
 * subscription) or the BYOK provider in ELEVATE_PROVIDER. Usage: pnpm smoke:copilot
 */
import { z } from "zod";
import { CopilotLLM, modelConfigFromEnv, stopCopilotClient } from "../packages/agent/src/index.ts";

const config = modelConfigFromEnv();
console.log(`provider ${config.provider}${config.model ? `, model ${config.model}` : ""}`);
const started = Date.now();
try {
  const out = await new CopilotLLM(config).json({
    task: "smoke",
    system: "You answer with JSON that matches the schema exactly.",
    prompt: "Reply with ok=true and the name of one well-known software testing technique.",
    schema: z.object({ ok: z.boolean(), technique: z.string() }),
    timeoutMs: 90_000,
  });
  console.log(`ok in ${((Date.now() - started) / 1000).toFixed(1)}s:`, out);
  await stopCopilotClient().catch(() => {});
  process.exit(out.ok ? 0 : 1);
} catch (e) {
  console.error(`failed: ${(e as Error).message}`);
  await stopCopilotClient().catch(() => {});
  process.exit(1);
}
