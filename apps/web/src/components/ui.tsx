"use client";

import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { Tooltip as BaseTooltip } from "@base-ui/react/tooltip";
import NumberFlow from "@number-flow/react";
import { cva, type VariantProps } from "class-variance-authority";
import { useRef, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { scoreTone, type Tone } from "@/lib/tone";

export const buttonVariants = cva(
  "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-[transform,background-color,border-color,color,opacity] duration-150 ease-[var(--ease-out)] active:scale-[0.97] disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        primary: "bg-fg text-bg hover:bg-fg/90",
        secondary: "border border-line-strong bg-raised/70 text-fg hover:bg-raised",
        ghost: "text-muted hover:bg-ink/5 hover:text-fg",
        danger: "border border-danger/40 bg-danger/10 text-danger hover:bg-danger/20",
      },
      size: { sm: "h-8 px-3 text-[13px]", md: "h-9 px-4", lg: "h-11 px-5 text-[15px]", icon: "size-8" },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export function Button({ className, variant, size, ...props }: ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

const tones: Record<Tone, string> = {
  neutral: "border-line-strong bg-ink/5 text-muted",
  sky: "border-sky/30 bg-sky/10 text-sky",
  olive: "border-olive/30 bg-olive/10 text-olive",
  sand: "border-sand/30 bg-sand/10 text-sand",
  danger: "border-danger/30 bg-danger/10 text-danger",
};
export type { Tone };

export function Badge({ tone = "neutral", className, ...props }: ComponentProps<"span"> & { tone?: Tone }) {
  return <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium [&_svg]:size-3", tones[tone], className)} {...props} />;
}

export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("rounded-[var(--radius-card)] border border-line bg-panel/80 backdrop-blur-sm", className)} {...props} />;
}

/** Aceternity-style card: a soft radial light follows the pointer across the border and surface. */
export function SpotlightCard({ className, children, ...props }: ComponentProps<"div">) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={ref}
      onPointerMove={(e) => {
        const r = ref.current?.getBoundingClientRect();
        if (!r) return;
        ref.current!.style.setProperty("--x", `${e.clientX - r.left}px`);
        ref.current!.style.setProperty("--y", `${e.clientY - r.top}px`);
      }}
      className={cn(
        "group/spot relative overflow-hidden rounded-[var(--radius-card)] border border-line bg-panel/80 backdrop-blur-sm transition-colors duration-200 hover:border-line-strong",
        "before:pointer-events-none before:absolute before:inset-0 before:opacity-0 before:transition-opacity before:duration-300 hover:before:opacity-100",
        "before:bg-[radial-gradient(360px_circle_at_var(--x)_var(--y),color-mix(in_oklch,var(--color-ink)_6%,transparent),transparent_60%)]",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function ShimmerText({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "animate-shimmer bg-[linear-gradient(110deg,var(--color-faint)_35%,var(--color-fg)_50%,var(--color-faint)_65%)] bg-[length:200%_100%] bg-clip-text text-transparent",
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Switch({ className, ...props }: ComponentProps<typeof BaseSwitch.Root>) {
  return (
    <BaseSwitch.Root
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-line-strong bg-raised p-0.5 transition-colors duration-200 ease-[var(--ease-out)] data-[checked]:border-olive/50 data-[checked]:bg-olive/70 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
        className,
      )}
      {...props}
    >
      <BaseSwitch.Thumb className="block size-3.5 rounded-full bg-fg shadow transition-transform duration-200 ease-[var(--ease-out)] data-[checked]:translate-x-4" />
    </BaseSwitch.Root>
  );
}

export function Tip({ content, children }: { content: ReactNode; children: React.ReactElement }) {
  return (
    <BaseTooltip.Root>
      <BaseTooltip.Trigger render={children} />
      <BaseTooltip.Portal>
        <BaseTooltip.Positioner sideOffset={6}>
          <BaseTooltip.Popup className="popup max-w-xs rounded-md border border-line-strong bg-raised px-2 py-1 text-xs text-fg shadow-lg">{content}</BaseTooltip.Popup>
        </BaseTooltip.Positioner>
      </BaseTooltip.Portal>
    </BaseTooltip.Root>
  );
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <BaseDialog.Root open={open} onOpenChange={onOpenChange}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="dialog-backdrop fixed inset-0 z-50 bg-black/60 backdrop-blur-[2px]" />
        <BaseDialog.Popup
          className={cn(
            "dialog-popup fixed left-1/2 top-1/2 z-50 w-[min(92vw,520px)] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-line-strong bg-panel p-6 shadow-2xl",
            className,
          )}
        >
          <BaseDialog.Title className="text-base font-semibold">{title}</BaseDialog.Title>
          {description && <BaseDialog.Description className="mt-1 text-sm text-muted">{description}</BaseDialog.Description>}
          <div className="mt-5">{children}</div>
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}

const ringColor: Record<Tone, string> = {
  neutral: "var(--color-faint)",
  sky: "var(--color-sky)",
  olive: "var(--color-olive)",
  sand: "var(--color-sand)",
  danger: "var(--color-danger)",
};

export function ScoreRing({ value, size = 44, tone, label }: { value: number | null | undefined; size?: number; tone?: Tone; label?: string }) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const t = tone ?? scoreTone(value);
  return (
    <div className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }} aria-label={label ? `${label} ${v}` : undefined}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-line-strong)" strokeWidth={3} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={ringColor[t]}
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v / 100)}
          style={{ transition: "stroke-dashoffset 600ms var(--ease-out)" }}
        />
      </svg>
      <span className="absolute text-[13px] font-semibold tabular-nums">{value == null ? "–" : <NumberFlow value={Math.round(v)} />}</span>
    </div>
  );
}

const toneText: Record<Tone, string> = { neutral: "", sky: "text-sky", olive: "text-olive", sand: "text-sand", danger: "text-danger" };

export function Stat({ label, value, tone, hint }: { label: string; value: number; tone?: Tone; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-xs uppercase tracking-wider text-faint">{label}</div>
      <div className={cn("mt-1 text-3xl font-semibold tabular-nums tracking-tight", tone && toneText[tone])}>
        <NumberFlow value={value ?? 0} />
      </div>
      {hint && <div className="mt-0.5 text-xs text-faint">{hint}</div>}
    </div>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="grid place-items-center rounded-[var(--radius-card)] border border-dashed border-line-strong px-6 py-14 text-center">
      {icon && <div className="mb-3 text-faint [&_svg]:size-6">{icon}</div>}
      <div className="font-medium">{title}</div>
      {children && <div className="mt-1 max-w-md text-sm text-muted">{children}</div>}
    </div>
  );
}
