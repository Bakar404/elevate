/** UI preferences stored in cookies so the server renders the right state on first paint. */

export const SIDEBAR_COOKIE = "elevate-sidebar";
export const SIDEBAR_EVENT = "elevate:sidebar";

export const THEME_COOKIE = "elevate-theme";
export type Theme = "dark" | "light";

/**
 * Runs before paint. A saved choice is already on <html> from the server; without one,
 * follow the OS setting so the first visit doesn't flash the wrong theme.
 */
export const themeBootScript = `(()=>{try{var d=document.documentElement;if(document.cookie.indexOf("elevate-theme=")>-1)return;var l=matchMedia("(prefers-color-scheme: light)").matches;d.classList.toggle("light",l);d.classList.toggle("dark",!l)}catch(e){}})()`;

export const LOGO_COOKIE = "elevate-logo";
export const LOGO_VARIANTS = ["ascent", "summit", "steps", "lift", "contour"] as const;
export type LogoVariant = (typeof LOGO_VARIANTS)[number];
export const DEFAULT_LOGO: LogoVariant = "ascent";

export const LOGO_INFO: Record<LogoVariant, { name: string; idea: string }> = {
  ascent: { name: "Ascent", idea: "Two rising chevrons: the repo, and the better version of it one step up." },
  summit: { name: "Summit", idea: "A peak under a rising sun, borrowed from the dither landscape behind the inbox." },
  steps: { name: "Steps", idea: "Three bars climbing to a lit node. Each recommendation is one verified step." },
  lift: { name: "Lift", idea: "A swarm of three agents raising one node. Reads as a graph, like the home map." },
  contour: { name: "Contour", idea: "Topographic elevation lines with the summit marked. Quiet, and holds up tiny." },
};

export function isLogoVariant(v: unknown): v is LogoVariant {
  return typeof v === "string" && (LOGO_VARIANTS as readonly string[]).includes(v);
}

export function setPrefCookie(name: string, value: string) {
  document.cookie = `${name}=${value}; path=/; max-age=31536000; samesite=lax`;
}
