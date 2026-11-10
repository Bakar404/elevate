import { listRecommendations } from "@elevate/engine";
import { route } from "@/lib/api";

export const dynamic = "force-dynamic";
export const GET = route((ctx, req) => listRecommendations(ctx, req.nextUrl.searchParams.get("status") ?? undefined));
