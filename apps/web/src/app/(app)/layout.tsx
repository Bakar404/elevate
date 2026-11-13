import { stats } from "@elevate/engine";
import { cookies } from "next/headers";
import { CommandPalette } from "@/components/command-palette";
import { LiveRefresh } from "@/components/live-refresh";
import { DEFAULT_LOGO, isLogoVariant, LOGO_COOKIE, PIP_COOKIE, SIDEBAR_COOKIE } from "@/lib/prefs";
import { PipDock } from "@/components/mascot";
import { MobileTabBar, MobileTopBar } from "@/components/mobile-nav";
import { BackToTop, ScrollProgress } from "@/components/scroll";
import { Sidebar } from "@/components/sidebar";
import { getCtx } from "@/lib/server";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getCtx();
  const [s, jar] = await Promise.all([stats(ctx), cookies()]);
  const logo = jar.get(LOGO_COOKIE)?.value;
  const counts = { open: s.open, activeSwarms: s.activeSwarms };
  const pipShown = jar.get(PIP_COOKIE)?.value !== "off";
  return (
    <div className="flex min-h-dvh">
      <Sidebar
        demo={ctx.demo}
        counts={counts}
        logo={isLogoVariant(logo) ? logo : DEFAULT_LOGO}
        initialCollapsed={jar.get(SIDEBAR_COOKIE)?.value === "collapsed"}
      />
      {/* Room at the end of each page so the corner Pip never sits on the last row; pages that lift Pip (chat) opt out. */}
      <main className="relative min-w-0 flex-1 max-md:pb-[calc(4rem+env(safe-area-inset-bottom))] md:pip-on:pb-16 md:pip-on:has-[[data-pip-lift]]:pb-0">
        <MobileTopBar demo={ctx.demo} logo={isLogoVariant(logo) ? logo : DEFAULT_LOGO} counts={counts} pipHidden={!pipShown} />
        {children}
      </main>
      <MobileTabBar counts={counts} />
      <ScrollProgress />
      <BackToTop />
      <PipDock counts={counts} initialShown={pipShown} />
      <CommandPalette />
      <LiveRefresh />
    </div>
  );
}
