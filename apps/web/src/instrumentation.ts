export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { getCtx } = await import("./lib/server");
  await getCtx().catch((err) => console.error("[elevate] engine failed to start:", err));
}
