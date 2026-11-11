"use client";

import { Bot, Command, Cpu, FolderGit2, Inbox, PanelLeftClose, PanelLeftOpen, Radar, Settings } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { cn } from "@/lib/utils";
import { setPrefCookie, SIDEBAR_COOKIE, SIDEBAR_EVENT, type LogoVariant } from "@/lib/prefs";
import { LogoMark } from "./logo";
import { PipCompanion } from "./mascot";
import { ThemeToggle } from "./theme";
import { Badge, Tip } from "./ui";

export const NAV = [
  { href: "/", label: "Inbox", icon: Inbox, key: "open" as const },
  { href: "/radar", label: "Radar", icon: Radar },
  { href: "/repos", label: "Repos", icon: FolderGit2 },
  { href: "/swarms", label: "Swarms", icon: Cpu, key: "activeSwarms" as const },
  { href: "/chat", label: "Chat", icon: Bot },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function isActive(pathname: string, href: string) {
  if (href === "/") return pathname === "/" || pathname.startsWith("/r/");
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function Sidebar({
  demo,
  counts,
  logo,
  initialCollapsed = false,
  pipHidden = false,
}: {
  demo: boolean;
  counts: { open: number; activeSwarms: number };
  logo?: LogoVariant;
  initialCollapsed?: boolean;
  pipHidden?: boolean;
}) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(initialCollapsed);

  const toggle = useCallback(() => setCollapsed((c) => !c), []);

  useEffect(() => {
    setPrefCookie(SIDEBAR_COOKIE, collapsed ? "collapsed" : "open");
  }, [collapsed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "b" && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(SIDEBAR_EVENT, toggle);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(SIDEBAR_EVENT, toggle);
    };
  }, [toggle]);

  // Labels stay mounted and fade, so the width animation reveals them instead of popping them in.
  const label = cn("whitespace-nowrap transition-opacity duration-200 max-md:hidden", collapsed && "pointer-events-none opacity-0");
  const tip = (content: string, el: ReactElement) => (collapsed ? <Tip content={content}>{el}</Tip> : el);

  return (
    <aside
      data-testid="sidebar"
      data-collapsed={collapsed}
      className={cn(
        "sticky top-0 z-20 flex h-dvh shrink-0 flex-col overflow-x-clip border-r border-line bg-bg/80 px-3 py-4 backdrop-blur-md",
        "transition-[width] duration-300 ease-[var(--ease-drawer)] max-md:hidden",
        collapsed ? "w-16" : "w-56",
      )}
    >
      <Link href="/" className="mb-6 flex h-8 items-center gap-2.5 px-1" aria-label="elevate home">
        <LogoMark variant={logo} size={28} />
        <span className={cn("font-semibold tracking-tight", label)}>elevate</span>
        {demo && (
          <Badge tone="sand" className={cn("ml-auto", label)} data-testid="demo-badge">
            demo
          </Badge>
        )}
      </Link>
      <nav className="flex flex-col gap-0.5">
        {NAV.map(({ href, label: text, icon: Icon, key }) => {
          const active = isActive(pathname, href);
          const n = key ? counts[key] : 0;
          return (
            <span key={href} className="contents">
              {tip(
                text,
                <Link
                  href={href}
                  aria-label={text}
                  className={cn(
                    "relative flex h-9 items-center gap-3 rounded-lg px-2.5 text-sm transition-colors duration-150",
                    active ? "text-fg" : "text-muted hover:text-fg",
                  )}
                >
                  {active && (
                    <motion.span
                      layoutId="nav-active"
                      className="absolute inset-0 rounded-lg border border-line-strong bg-ink/[0.06]"
                      transition={{ type: "spring", duration: 0.35, bounce: 0.15 }}
                    />
                  )}
                  <Icon className="relative size-4 shrink-0" />
                  <span className={cn("relative", label)}>{text}</span>
                  {n > 0 && <span className={cn("relative ml-auto text-xs tabular-nums text-faint", label)}>{n}</span>}
                  {n > 0 && collapsed && <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-olive" />}
                </Link>,
              )}
            </span>
          );
        })}
      </nav>
      <div className="mt-auto flex flex-col gap-1.5">
        <PipCompanion counts={counts} compact={collapsed} initialHidden={pipHidden} />
        {tip("Toggle theme", <ThemeToggle labelClassName={label} />)}
        {tip(
          "Command ⌘K",
          <button
            onClick={() => window.dispatchEvent(new Event("elevate:palette"))}
            aria-label="Command palette"
            className="flex h-9 items-center gap-2 rounded-lg border border-line px-2.5 text-sm text-faint transition-colors hover:border-line-strong hover:text-muted"
          >
            <Command className="size-3.5 shrink-0" />
            <span className={label}>Command</span>
            <kbd className={cn("ml-auto font-mono text-[11px]", label)}>⌘K</kbd>
          </button>,
        )}
        {tip(
          "Expand ⌘B",
          <button
            onClick={toggle}
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            data-testid="sidebar-toggle"
            className="flex h-9 items-center gap-2 rounded-lg px-2.5 text-sm text-faint transition-colors hover:bg-ink/5 hover:text-muted max-md:hidden"
          >
            {collapsed ? <PanelLeftOpen className="size-4 shrink-0" /> : <PanelLeftClose className="size-4 shrink-0" />}
            <span className={label}>Collapse</span>
            <kbd className={cn("ml-auto font-mono text-[11px]", label)}>⌘B</kbd>
          </button>,
        )}
      </div>
    </aside>
  );
}
