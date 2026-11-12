import { useSyncExternalStore } from "react";

let query: MediaQueryList | undefined;
const media = () => (query ??= matchMedia("(prefers-reduced-motion: reduce)"));

function subscribe(onChange: () => void) {
  media().addEventListener("change", onChange);
  return () => media().removeEventListener("change", onChange);
}
const getSnapshot = () => media().matches;
const getServerSnapshot = () => false;

/**
 * Whether the user asked for reduced motion. The server can't know, so hydration renders as if not
 * (matching the server's HTML) and React re-renders with the real setting right after. motion's own
 * useReducedMotion reads the setting during hydration, which makes the tree mismatch.
 */
export function usePrefersReducedMotion() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
