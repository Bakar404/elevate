import { getRecommendation } from "@elevate/engine";
import { NextResponse } from "next/server";
import { route } from "@/lib/api";

export const dynamic = "force-dynamic";
export const GET = route(async (ctx, _req, { id }) => (await getRecommendation(ctx, id!)) ?? NextResponse.json({ error: "Not found" }, { status: 404 }));
