# Design

A calm, dark work surface over a living, dithered landscape. The background carries the mood, so the UI itself stays quiet and dense.

## Libraries

| Library | Where it's used |
|---|---|
| [Base UI](https://base-ui.com/) | Unstyled, accessible primitives behind `components/ui.tsx`: Dialog, Switch and Tooltip |
| [shadcn/ui](https://ui.shadcn.com/) | The component pattern: our own copy in `ui.tsx`, with `cva` variants and `cn()` (clsx + tailwind-merge), restyled to our tokens |
| [Aceternity](https://ui.aceternity.com/), [21st.dev](https://21st.dev/), [rareui](https://rareui.in/), [beautifului](https://www.beautifului.dev/) | Effect references, rebuilt small and token-driven: `SpotlightCard` (a pointer-following radial light), `ShimmerText`, and the staggered fade-up on lists |
| [Sonner](https://sonner.emilkowal.ski/) | Every toast: approve, launch, settings saved, live events (`live-refresh.tsx`) |
| [cmdk](https://github.com/dip/cmdk) | The ⌘K palette: navigate, open a recommendation, run a sweep, start a chat |
| [NumberFlow](https://number-flow.barvian.me/) | Animated scores (`ScoreRing`) and counters (`Stat`) |
| [motion](https://motion.dev/) | The active-route indicator in the sidebar (shared `layoutId`) |
| [CUI](https://yappologistic.github.io/CUI/) | Background inspiration only. CUI is a C/WASM UI library and doesn't fit a React app |

## Background

`components/dither-background.tsx` is the Inbox hero. It is a procedural landscape (value-noise hills and fbm clouds) drawn through an 8×8 Bayer ordered dither in four natural colours: sky, cloud, olive and sand.

- Each dither cell is 2 CSS px, snapped to device pixels, so it stays crisp at any zoom level.
- The canvas renders at cell resolution and is upscaled with `image-rendering: pixelated`, so a frame is cheap.
- Clouds drift at about 15 fps. Rendering pauses when the hero is off-screen or the tab is hidden, and under `prefers-reduced-motion` it draws one static frame.
- A vertical scrim fades the landscape into `bg`, so the content below keeps its contrast.

## Tokens (`app/globals.css`, Tailwind v4 `@theme`)

- **Surfaces:** `bg` → `panel` → `raised`, each a few steps of OKLCH lightness at hue 250. Borders are white at 8% (`line`) and 14% (`line-strong`).
- **Text:** `fg`, `muted` and `faint`. Body copy is never set below `muted`.
- **Accents:** these reuse the background palette, so the UI and the landscape belong together.

  | Accent | Meaning |
  |---|---|
  | `sky` | primary and in-progress |
  | `olive` | passed and PR opened |
  | `sand` | warning and medium risk |
  | `danger` | failed and gated out |

- **Type:** Inter for UI, JetBrains Mono for scores, hashes and code.
- **Radius:** 14 px on cards, smaller on controls.

## Motion (Emil Kowalski's rules)

- Use custom curves only: `--ease-out` (0.23, 1, 0.32, 1) for entering, `--ease-in-out` for moving on screen, and `--ease-drawer` for sheets.
- Keep it fast. UI feedback takes 150–250 ms, and entrances take at most 400 ms. Nothing animates from `scale(0)`; elements start at 0.96 or above, with opacity.
- Animate only `transform` and `opacity`.
- Stagger lists by 40 ms per item, capped at 8 items, so long lists don't feel slow.
- No animation on actions repeated many times a day: the palette opens instantly, and so does keyboard navigation.
- Honour `prefers-reduced-motion` everywhere. Toasts, shimmer and the background degrade to static.

## Shell and live map

- **Sidebar:** collapses to a 64 px icon rail with the toggle at the bottom, ⌘B, or "Toggle sidebar" in ⌘K. When collapsed, labels fade out instead of unmounting, tooltips name each icon, and an olive dot stands in for counts. The choice is remembered in a cookie, so the server renders the right width and nothing flickers.
- **Live map** (home): the logo hub in the middle, watched repos on an inner ring, and matched techniques (sand diamonds) on an outer ring next to the repos they apply to.
  - Each technique→repo link is styled by recommendation status:
    - dashed and marching: still being gated
    - olive with one particle: awaiting approval
    - sky with two fast particles: swarm running
    - sand: draft PR open
  - A repo that is being worked on, or that has recommendations waiting, pulses.
  - Hovering a node dims everything that isn't connected to it.
  - All motion is SVG/SMIL and CSS and stops under `prefers-reduced-motion`.
- **Logo:** five drafts are available at `/brand` (Ascent, Summit, Steps, Lift, Contour). Picking one sets a cookie, and the sidebar and map hub update. The favicon is the Ascent mark.
## Interaction

- Every action is reachable from ⌘K, and every destructive or writing action asks for confirmation. Approving a recommendation shows exactly which repo, which executor and which budget.
- Gate results are shown as evidence, not just scores: each gate card lists its reasons, cited links and the threshold it was held to.
- Live state arrives over SSE, with no manual refresh. Swarm timelines stream in place.
