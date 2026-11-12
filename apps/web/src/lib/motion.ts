import { useSyncExternalStore } from "react";
import { MOTION_COOKIE, setPrefCookie, type MotionPref } from "./prefs";

let query: MediaQueryList | undefined;
const media = () => (query ??= matchMedia("(prefers-reduced-motion: reduce)"));
const systemReducesMotion = () => media().matches;

/** The choice in Settings → Motion. The server renders it from the cookie as <html data-motion>; no attribute means "system". */
export function motionPref(): MotionPref {
  const v = document.documentElement.dataset.motion;
  return v === "on" || v === "off" ? v : "system";
}

export function setMotionPref(pref: MotionPref) {
  const d = document.documentElement;
  if (pref === "system") delete d.dataset.motion;
  else d.dataset.motion = pref;
  setPrefCookie(MOTION_COOKIE, pref);
}

/** Hold still when elevate is set to Off, or when it follows the system and the system asks for reduced motion. */
export function prefersReducedMotion() {
  const pref = motionPref();
  return pref === "off" || (pref === "system" && systemReducesMotion());
}

/** Calls back when the system setting or the choice in Settings → Motion changes. */
export function subscribeMotion(onChange: () => void) {
  const m = media();
  m.addEventListener("change", onChange);
  const obs = new MutationObserver(onChange);
  obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
  return () => {
    m.removeEventListener("change", onChange);
    obs.disconnect();
  };
}

/**
 * Whether to hold still. The server can't know the system setting, so hydration renders as if not
 * (matching the server's HTML) and React re-renders with the real answer right after. motion's own
 * useReducedMotion reads the setting during hydration, which makes the tree mismatch.
 */
export function usePrefersReducedMotion() {
  return useSyncExternalStore(subscribeMotion, prefersReducedMotion, () => false);
}

/** Whether the system itself asks for reduced motion, whatever elevate is set to. */
export function useSystemReducesMotion() {
  return useSyncExternalStore(subscribeMotion, systemReducesMotion, () => false);
}

/** `initial` is what the server read from the cookie, so the first render matches its HTML. */
export function useMotionPref(initial: MotionPref = "system") {
  return useSyncExternalStore(subscribeMotion, motionPref, () => initial);
}
