import { learnerSummary, resetLearner } from "@elevate/engine";
import { route } from "@/lib/api";

export const dynamic = "force-dynamic";

/** What elevate has learned from your likes, dislikes, approvals and rejections. */
export const GET = route((ctx) => learnerSummary(ctx));

/** Forget all of it: recommendations are ranked from the prior again. */
export const DELETE = route((ctx) => resetLearner(ctx));
