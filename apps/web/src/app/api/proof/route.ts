import { NextResponse } from "next/server";
import { readReceipt } from "@/lib/proof";

export const dynamic = "force-dynamic";
export function GET() {
  return NextResponse.json(readReceipt() ?? { error: "No receipt yet; run pnpm proof" }, { status: readReceipt() ? 200 : 404 });
}
