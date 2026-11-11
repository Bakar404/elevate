import { stats } from "@elevate/engine";
import { cookies } from "next/headers";
import { CommandPalette } from "@/components/command-palette";
import { LiveRefresh } from "@/components/live-refresh";
import { DEFAULT_LOGO, isLogoVariant, LOGO_COOKIE, SIDEBAR_COOKIE } from "@/lib/prefs";
import { MobileTabBar, MobileTopBar } from "@/components/mobile-nav";
import { BackToTop, ScrollProgress } from "@/components/scroll";
import { Sidebar } from "@/components/sidebar";
import { getCtx } from "@/lib/server";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getCtx();
  const [s, jar] = await Promise.all([stats(ctx), cookies()]);
  const logo = jar.get(LOGO_COOKIE)?.value;
  return (
    <div className="flex min-h-dvh">
      <Sidebar
        demo={ctx.demo}
        counts={{ open: s.open, activeSwarms: s.activeSwarms }}
        logo={isLogoVariant(logo) ? logo : DEFAULT_LOGO}
        initialCollapsed={jar.get(SIDEBAR_COOKIE)?.value === "collapsed"}
      />
      <main className="relative min-w-0 flex-1 max-md:pb-[calc(4rem+env(safe-area-inset-bottom))]">
        <MobileTopBar demo={ctx.demo} logo={isLogoVariant(logo) ? logo : DEFAULT_LOGO} />
        {children}
      </main>
      <MobileTabBar counts={{ open: s.open, activeSwarms: s.activeSwarms }} />
      <ScrollProgress />
      <BackToTop />
      <CommandPalette />
      <LiveRefresh />
    </div>
  );
}
