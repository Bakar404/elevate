"use client";

import { Search } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import type { LogoVariant } from "@/lib/prefs";
import { LogoMark } from "./logo";
import { isActive, NAV } from "./sidebar";
import { ThemeToggle } from "./theme";
import { Badge } from "./ui";

/** Phone chrome: a slim top bar plus a thumb-reachable tab bar. Hidden from md up, where the sidebar takes over. */
export function MobileTopBar({ demo, logo }: { demo: boolean; logo?: LogoVariant }) {
  return (
    <header
      data-testid="mobile-topbar"
      className="flex h-[calc(3.5rem+env(safe-area-inset-top))] items-center gap-2 border-b border-line bg-bg/80 px-4 pt-[env(safe-area-inset-top)] backdrop-blur-md md:hidden"
    >
      <Link href="/" className="flex items-center gap-2" aria-label="elevate home">
        <LogoMark variant={logo} size={26} />
        <span className="font-semibold tracking-tight">elevate</span>
      </Link>
      {demo && (
        <Badge tone="sand" data-testid="demo-badge-mobile">
          demo
        </Badge>
      )}
      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event("elevate:palette"))}
          aria-label="Search"
          className="grid size-10 place-items-center rounded-lg text-muted transition-colors hover:bg-ink/5 hover:text-fg"
        >
          <Search className="size-[18px]" />
        </button>
        <ThemeToggle showLabel={false} testId="theme-toggle-mobile" className="size-10 justify-center px-0" />
      </div>
    </header>
  );
}

export function MobileTabBar({ counts }: { counts: { open: number; activeSwarms: number } }) {
  const pathname = usePathname();
  return (
    <nav
      aria-label="Main"
      data-testid="mobile-tabbar"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-bg/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-md md:hidden"
    >
      <ul className="grid h-16 grid-cols-6">
        {NAV.map(({ href, label, icon: Icon, key }) => {
          const active = isActive(pathname, href);
          const n = key ? counts[key] : 0;
          return (
            <li key={href}>
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative flex h-full flex-col items-center justify-center gap-1 text-[10px] font-medium transition-colors",
                  active ? "text-fg" : "text-faint hover:text-muted",
                )}
              >
                {active && <span className="absolute inset-x-3 top-0 h-0.5 rounded-full bg-sky" aria-hidden />}
                <span className="relative">
                  <Icon className="size-5" />
                  {n > 0 && (
                    <span className="absolute -right-2 -top-1.5 min-w-4 rounded-full bg-olive px-1 text-center text-[9px] font-semibold leading-4 text-bg tabular-nums">
                      {n}
                    </span>
                  )}
                </span>
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
