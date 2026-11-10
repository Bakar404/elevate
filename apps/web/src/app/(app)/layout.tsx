import { stats } from "@elevate/engine";
import { CommandPalette } from "@/components/command-palette";
import { LiveRefresh } from "@/components/live-refresh";
import { Sidebar } from "@/components/sidebar";
import { getCtx } from "@/lib/server";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getCtx();
  const s = await stats(ctx);
  return (
    <div className="flex min-h-dvh">
      <Sidebar demo={ctx.demo} counts={{ open: s.open, activeSwarms: s.activeSwarms }} />
      <main className="relative min-w-0 flex-1">{children}</main>
      <CommandPalette />
      <LiveRefresh />
    </div>
  );
}
