import { listSwarms } from "@elevate/engine";
import { route } from "@/lib/api";

export const dynamic = "force-dynamic";
export const GET = route((ctx) => listSwarms(ctx));
