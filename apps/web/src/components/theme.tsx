"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Toaster } from "sonner";
import { setPrefCookie, THEME_COOKIE, type Theme } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { usePipShown } from "./mascot";

export const THEME_EVENT = "elevate:theme";

const read = (): Theme => (typeof document !== "undefined" && document.documentElement.classList.contains("light") ? "light" : "dark");

export function setTheme(t: Theme) {
  const d = document.documentElement;
  d.classList.toggle("light", t === "light");
  d.classList.toggle("dark", t === "dark");
  setPrefCookie(THEME_COOKIE, t);
}

export function toggleTheme() {
  setTheme(read() === "light" ? "dark" : "light");
}

/** Current theme, kept in sync with the class on <html> however it changes. */
export function useTheme(): Theme {
  const [theme, set] = useState<Theme>("dark");
  useEffect(() => {
    set(read());
    const obs = new MutationObserver(() => set(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, []);
  return theme;
}

export function ThemeToggle({
  className,
  showLabel = true,
  labelClassName,
  testId = "theme-toggle",
}: {
  className?: string;
  showLabel?: boolean;
  labelClassName?: string;
  testId?: string;
}) {
  const theme = useTheme();
  const next = theme === "light" ? "dark" : "light";
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      aria-label={`Switch to ${next} theme`}
      data-testid={testId}
      data-theme={theme}
      className={cn("flex h-9 items-center gap-2 rounded-lg px-2.5 text-sm text-faint transition-colors hover:bg-ink/5 hover:text-muted", className)}
    >
      <span className="relative size-4 shrink-0">
        <Sun className={cn("absolute inset-0 size-4 transition-[opacity,transform] duration-300 ease-[var(--ease-out)]", theme === "light" ? "rotate-0 opacity-100" : "-rotate-90 scale-50 opacity-0")} />
        <Moon className={cn("absolute inset-0 size-4 transition-[opacity,transform] duration-300 ease-[var(--ease-out)]", theme === "dark" ? "rotate-0 opacity-100" : "rotate-90 scale-50 opacity-0")} />
      </span>
      {showLabel && <span className={labelClassName}>{theme === "light" ? "Light" : "Dark"}</span>}
    </button>
  );
}

/** Mounted once at the root, so it also owns the global "toggle theme" event (⌘K). On desktop, toasts stack above the corner Pip. */
export function ThemedToaster() {
  const theme = useTheme();
  const pip = usePipShown();
  useEffect(() => {
    window.addEventListener(THEME_EVENT, toggleTheme);
    return () => window.removeEventListener(THEME_EVENT, toggleTheme);
  }, []);
  return (
    <Toaster
      theme={theme}
      position="bottom-right"
      offset={pip ? { bottom: "calc(6rem + var(--pip-lift, 0px))" } : undefined}
      mobileOffset={{ bottom: "calc(5rem + env(safe-area-inset-bottom))" }}
      toastOptions={{ className: "!bg-panel !border-line-strong !text-fg" }}
    />
  );
}
