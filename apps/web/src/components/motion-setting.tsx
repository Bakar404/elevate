"use client";

import { toast } from "sonner";
import { setMotionPref, useMotionPref, useSystemReducesMotion } from "@/lib/motion";
import { MOTION_PREFS, type MotionPref } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { Card } from "./ui";

const OPTIONS: Record<MotionPref, { label: string; hint: string; saved: string }> = {
  system: { label: "Match system", hint: "Follow your device's reduced-motion setting.", saved: "Following your system's motion setting" },
  on: { label: "On", hint: "Animate even when the system asks for less motion.", saved: "Animations on in this browser" },
  off: { label: "Off", hint: "Hold still everywhere.", saved: "Motion off in this browser" },
};

function status(pref: MotionPref, systemReduces: boolean) {
  if (pref === "off") return "Holding still in this browser, whatever your system says.";
  if (pref === "on") return systemReduces ? "Animating, even though your system asks for reduced motion." : "Animating, whatever your system says.";
  return systemReduces
    ? "Your system asks apps to reduce motion (Remote Desktop often does), so elevate holds still and the live map offers to animate anyway. Pick On or Off to decide for this browser."
    : "Your system allows motion, so elevate animates.";
}

/** Settings → Motion: whether elevate animates in this browser. A cookie, like the theme, so the server renders it on <html>. */
export function MotionSetting({ initial }: { initial: MotionPref }) {
  const pref = useMotionPref(initial);
  const systemReduces = useSystemReducesMotion();
  return (
    <Card id="motion" data-testid="motion-card" className="mt-8 scroll-mt-6 p-6">
      <h2 id="motion-label" className="font-medium">
        Motion
      </h2>
      <p className="mt-1 text-sm text-muted">Animations on the live map, Pip and the Inbox background. Saved in this browser.</p>
      <div role="radiogroup" aria-labelledby="motion-label" className="mt-4 grid gap-2 sm:grid-cols-3">
        {MOTION_PREFS.map((p) => (
          <label
            key={p}
            data-testid={`motion-${p}`}
            className={cn(
              "cursor-pointer rounded-xl border px-3 py-2.5 transition-[border-color,background-color] duration-150 has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-sky",
              pref === p ? "border-sky/50 bg-sky/10" : "border-line hover:border-line-strong",
            )}
          >
            <input
              type="radio"
              name="motion"
              value={p}
              checked={pref === p}
              onChange={() => {
                setMotionPref(p);
                toast.success(OPTIONS[p].saved);
              }}
              aria-label={OPTIONS[p].label}
              aria-describedby={`motion-${p}-hint`}
              className="sr-only"
            />
            <span className="block text-sm font-medium">{OPTIONS[p].label}</span>
            <span id={`motion-${p}-hint`} className="mt-0.5 block text-xs text-muted">
              {OPTIONS[p].hint}
            </span>
          </label>
        ))}
      </div>
      <p data-testid="motion-status" className="mt-3 text-xs text-faint">
        {status(pref, systemReduces)}
      </p>
    </Card>
  );
}
