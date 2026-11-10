import { availableModels, modelPrefs } from "@elevate/engine";
import { route } from "@/lib/api";

export const dynamic = "force-dynamic";
export const GET = route(async (ctx) => ({ ...(await availableModels(ctx)), prefs: await modelPrefs(ctx) }));