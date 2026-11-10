import { createThread, listThreads } from "@elevate/engine";
import { route } from "@/lib/api";

export const dynamic = "force-dynamic";
export const GET = route((ctx) => listThreads(ctx));
export const POST = route((ctx) => createThread(ctx));
