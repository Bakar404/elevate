"use client";

import { Bot, Command, Cpu, FolderGit2, Inbox, Radar, Settings } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Badge } from "./ui";

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

export function Sidebar({ demo, counts }: { demo: boolean; counts: { open: number; activeSwarms: number } }) {
  const pathname = usePathname();
  return (
    <aside className="sticky top-0 z-20 flex h-dvh w-56 shrink-0 flex-col border-r border-line bg-bg/80 px-3 py-4 backdrop-blur-md max-md:w-16">
      <Link href="/" className="mb-6 flex items-center gap-2 px-2">
        <span className="grid size-7 place-items-center rounded-lg bg-[linear-gradient(135deg,var(--color-sky),var(--color-olive))] text-[13px] font-bold text-bg">e</span>
        <span className="font-semibold tracking-tight max-md:hidden">elevate</span>
        {demo && (
          <Badge tone="sand" className="ml-auto max-md:hidden" data-testid="demo-badge">
            demo
          </Badge>
        )}
      </Link>
      <nav className="flex flex-col gap-0.5">
        {NAV.map(({ href, label, icon: Icon, key }) => {
          const active = isActive(pathname, href);
          const n = key ? counts[key] : 0;
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "relative flex h-9 items-center gap-3 rounded-lg px-2.5 text-sm transition-colors duration-150",
                active ? "text-fg" : "text-muted hover:text-fg",
              )}
            >
              {active && (
                <motion.span
                  layoutId="nav-active"
                  className="absolute inset-0 rounded-lg border border-line-strong bg-white/[0.06]"
                  transition={{ type: "spring", duration: 0.35, bounce: 0.15 }}
                />
              )}
              <Icon className="relative size-4 shrink-0" />
              <span className="relative max-md:hidden">{label}</span>
              {n > 0 && <span className="relative ml-auto text-xs tabular-nums text-faint max-md:hidden">{n}</span>}
            </Link>
          );
        })}
      </nav>
      <button
        onClick={() => window.dispatchEvent(new Event("elevate:palette"))}
        className="mt-auto flex h-9 items-center gap-2 rounded-lg border border-line px-2.5 text-sm text-faint transition-colors hover:border-line-strong hover:text-muted"
      >
        <Command className="size-3.5" />
        <span className="max-md:hidden">Command</span>
        <kbd className="ml-auto font-mono text-[11px] max-md:hidden">⌘K</kbd>
      </button>
    </aside>
  );
}
