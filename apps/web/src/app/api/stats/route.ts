import { stats } from "@elevate/engine";
import { route } from "@/lib/api";

export const dynamic = "force-dynamic";
export const GET = route((ctx) => stats(ctx));
