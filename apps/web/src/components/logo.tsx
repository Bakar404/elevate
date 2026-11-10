"use client";

import { useId } from "react";
import { DEFAULT_LOGO, type LogoVariant } from "@/lib/prefs";
import { cn } from "@/lib/utils";

/** The mark only: a rounded tile with the sky → olive gradient used across the app. */
export function LogoMark({ variant = DEFAULT_LOGO, size = 28, className }: { variant?: LogoVariant; size?: number; className?: string }) {
  const id = useId().replace(/:/g, "");
  const g = `lg-${id}`;
  const s = `ls-${id}`;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={cn("shrink-0", className)} role="img" aria-label="elevate">
      <defs>
        <linearGradient id={g} x1="0" y1="32" x2="32" y2="0" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--color-olive)" />
          <stop offset="1" stopColor="var(--color-sky)" />
        </linearGradient>
        <linearGradient id={s} x1="16" y1="0" x2="16" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="white" stopOpacity="0.18" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${g})`} />
      <rect x="0.5" y="0.5" width="31" height="31" rx="8.5" fill={`url(#${s})`} stroke="white" strokeOpacity="0.16" />
      <Glyph variant={variant} />
    </svg>
  );
}

const ink = "var(--color-bg)";

function Glyph({ variant }: { variant: LogoVariant }) {
  const line = { fill: "none", stroke: ink, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  switch (variant) {
    case "ascent":
      return (
        <g {...line} strokeWidth={3}>
          <path d="M9 21.5 16 14.5 23 21.5" strokeOpacity={0.55} />
          <path d="M9 15 16 8 23 15" />
        </g>
      );
    case "summit":
      return (
        <g>
          <path d="M5 25 14.5 11 19 17.5 21 15 27 25Z" fill={ink} />
          <path d="M11.6 15.3 14.5 11 17.2 14.9 15.6 14.2 14.4 15.6 13.1 14.4Z" fill="white" fillOpacity={0.55} />
          <path d="M14.5 11V4.5" {...line} strokeWidth={1.6} />
          <path d="M14.5 4.5h5.5l-1.6 1.8 1.6 1.8h-5.5Z" fill={ink} />
        </g>
      );
    case "steps":
      return (
        <g fill={ink}>
          <rect x="7" y="18" width="4.5" height="7" rx="1.6" opacity={0.5} />
          <rect x="13.75" y="13.5" width="4.5" height="11.5" rx="1.6" opacity={0.75} />
          <rect x="20.5" y="11" width="4.5" height="14" rx="1.6" />
          <circle cx="22.75" cy="6.75" r="2.25" />
        </g>
      );
    case "lift":
      return (
        <g>
          <g {...line} strokeWidth={1.8} strokeOpacity={0.6}>
            <path d="M8.5 23 16 10.5M16 23.5V10.5M23.5 23 16 10.5" />
          </g>
          <circle cx="16" cy="9.5" r="4" fill={ink} />
          <circle cx="8.5" cy="23" r="2.4" fill={ink} opacity={0.7} />
          <circle cx="16" cy="24" r="2.4" fill={ink} opacity={0.7} />
          <circle cx="23.5" cy="23" r="2.4" fill={ink} opacity={0.7} />
        </g>
      );
    case "contour":
      return (
        <g {...line} strokeWidth={1.9}>
          <path d="M5.5 24.5C8 19 11.5 17 16 17s8 2 10.5 7.5" strokeOpacity={0.45} />
          <path d="M9 24.5C10.5 20.5 13 19.5 16 19.5s5.5 1 7 5" strokeOpacity={0.45} />
          <path d="M7.5 18.5C9.5 12.5 12.5 10 16 10s6.5 2.5 8.5 8.5" strokeOpacity={0.75} />
          <path d="M11 17C12 13.8 13.8 12.8 16 12.8s4 1 5 4.2" strokeOpacity={0.75} />
          <circle cx="16" cy="6.5" r="2.2" fill={ink} stroke="none" />
        </g>
      );
  }
}

/** Mark + wordmark, as used in the sidebar. */
export function Logo({ variant, size = 28, showWord = true, className }: { variant?: LogoVariant; size?: number; showWord?: boolean; className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <LogoMark variant={variant} size={size} />
      {showWord && <span className="font-semibold tracking-tight">elevate</span>}
    </span>
  );
}
