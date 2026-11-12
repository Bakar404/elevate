import { closeSwarmPr, mergeSwarmPr, refreshSwarmPr } from "@elevate/engine";
import { z } from "zod";
import { body, route } from "@/lib/api";

const Action = z.object({ action: z.enum(["merge", "close", "refresh"]) });

/** The swarm page's PR buttons. Merge is your consent for this PR (M2); the guard still checks it's verified (M3). */
export const POST = route(async (ctx, req, { id }) => {
  const { action } = Action.parse(await body(req));
  const run = { merge: mergeSwarmPr, close: closeSwarmPr, refresh: refreshSwarmPr }[action];
  return { pr: await run(ctx, id!) };
});
