import { approveRecommendation, regateRecommendation, rejectRecommendation, retrySwarm, setFeedback } from "@elevate/engine";
import { NextResponse } from "next/server";
import { z } from "zod";
import { body, route } from "@/lib/api";

const executor = z.enum(["copilot-cloud", "claude-action", "codex-cloud", "local", "fake"]);
const Approve = z.object({
  executor,
  allowRepo: z.boolean().optional(),
  budget: z.object({ maxTasks: z.number().int().min(1).max(20), maxMinutes: z.number().int().min(5).max(600), maxAgentTurns: z.number().int().min(1).max(200) }).partial().optional(),
});

export const POST = route(async (ctx, req, { id, action }) => {
  const rid = id!;
  switch (action) {
    case "approve": {
      const a = Approve.parse(await body(req));
      if (a.executor === "fake" && !ctx.demo) throw new z.ZodError([{ code: "custom", path: ["executor"], message: "The fake executor is only for demo mode", input: a.executor }]);
      return { swarm: await approveRecommendation(ctx, rid, a) };
    }
    case "reject":
      return { status: await rejectRecommendation(ctx, rid) };
    case "regate":
      await regateRecommendation(ctx, rid);
      return { status: "candidate" };
    case "retry": {
      const { executor: ex } = z.object({ executor: executor.optional() }).parse(await body(req));
      return { swarm: await retrySwarm(ctx, rid, ex) };
    }
    case "feedback": {
      // Like or dislike; "none" takes the vote back. Votes train the ranking and never change the status.
      const { vote } = z.object({ vote: z.enum(["like", "dislike", "none"]) }).parse(await body(req));
      return setFeedback(ctx, rid, vote);
    }
    default:
      return NextResponse.json({ error: `Unknown action ${action}` }, { status: 404 });
  }
});
