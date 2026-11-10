import { listThreads } from "@elevate/engine";
import { Chat } from "@/components/chat";
import { getCtx } from "@/lib/server";

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const ctx = await getCtx();
  const threads = await listThreads(ctx);
  return <Chat threads={threads.map((t) => ({ id: t.id, title: t.title }))} demo={ctx.demo} />;
}
