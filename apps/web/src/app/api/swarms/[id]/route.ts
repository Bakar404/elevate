import { getSwarm } from "@elevate/engine";
import { NextResponse } from "next/server";
import { route } from "@/lib/api";

export const dynamic = "force-dynamic";
export const GET = route(async (ctx, _req, { id }) => (await getSwarm(ctx, id!)) ?? NextResponse.json({ error: "Not found" }, { status: 404 }));
