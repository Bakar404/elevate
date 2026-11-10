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

## Scrolling and search

- **Long pages scroll well:** a thin progress bar at the top, a back-to-top button after a screen of scrolling, sticky tab bars (inbox, radar) and a sticky repo search. Long lists use `content-visibility: auto`. Smooth scrolling is on only when reduced motion is not requested.
- **Repo search** (`/repos`, `/` to focus) ranks across name, description, language, topics, profile stack and domains. Every word must match; exact matches beat prefix matches, which beat substring matches. Case and accents are ignored. The query and filter (all, watched, swarm, has recs, unprofiled) live in the URL, so results can be shared and survive reloads.
- **⌘K** also finds repos by stack or domain and techniques by category or by the repo they were found for.
- **Search plan:** the home page and Radar show the terms the next sweep will search for each repo. Items found that way carry "Found searching" chips. The home page's "Fresh for your repos" never shows hype or irrelevant items.

## Models and chat

- The model picker is a popover with a cmdk list showing each model's cost ("included" or N×). Models your plan disables appear greyed out, and a "Use <id>" row accepts any id (needed for BYOK).
- Settings sets the background model and the chat default. The chat composer sets the model per conversation, and a change takes effect from the next message.
- Deleting a conversation is a hover or focus trash button, followed by a confirmation dialog. It is removed optimistically and restored if the request fails.

## Interaction

- Every action is reachable from ⌘K, and every destructive or writing action asks for confirmation. Approving a recommendation shows exactly which repo, which executor and which budget.
- Gate results are shown as evidence, not just scores: each gate card lists its reasons, cited links and the threshold it was held to.
- Live state arrives over SSE, with no manual refresh. Swarm timelines stream in place.
