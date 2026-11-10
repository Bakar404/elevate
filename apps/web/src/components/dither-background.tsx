"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";

/**
 * Procedural landscape rendered as an ordered (8×8 Bayer) dither in a four-colour natural palette.
 * Inspired by the CUI site background; the scene is generated, not a photo. Each dither cell is
 * 2 CSS px snapped to device pixels, so it stays crisp on every display.
 */

const BAYER = [
  0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11,
  43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
].map((v) => (v + 0.5) / 64);

const PALETTE = {
  sky: [74, 146, 222],
  cloud: [178, 206, 232],
  olive: [138, 168, 78],
  sand: [222, 196, 122],
} as const;

function hash(x: number, y: number, seed: number) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function valueNoise(x: number, y: number, seed: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, seed);
  const b = hash(xi + 1, yi, seed);
  const c = hash(xi, yi + 1, seed);
  const d = hash(xi + 1, yi + 1, seed);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, y: number, seed: number, octaves = 5) {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * f, y * f, seed + i * 17);
    f *= 2;
    amp *= 0.5;
  }
  return sum;
}

type Field = { w: number; h: number; lum: Float32Array; ground: Float32Array };

/** Static scene: sky with drifting cumulus above a horizon of layered hills and fields. */
function buildField(w: number, h: number, seed: number): Field {
  const lum = new Float32Array(w * h);
  const ground = new Float32Array(w * h);
  const scale = 1 / Math.max(w, 1);
  const hills = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const nx = x * scale;
    hills[x] = 0.58 + 0.07 * fbm(nx * 3, 0.5, seed + 3, 4) - 0.035 * Math.sin(nx * 5.2 + 1.3);
  }
  for (let y = 0; y < h; y++) {
    const ny = y / h;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const nx = x * scale;
      const horizon = hills[x]!;
      if (ny < horizon) {
        const height = ny / horizon;
        const cloud = fbm(nx * 4.2, ny * 7.5, seed, 5);
        const billow = Math.max(0, cloud - 0.47) * 2.6 * (1 - height * 0.55);
        lum[i] = Math.min(1, 0.12 + height * 0.3 + billow);
        ground[i] = Math.max(0, (ny - horizon + 0.02) / 0.02);
      } else {
        const depth = (ny - horizon) / (1 - horizon);
        const furrows = 0.5 + 0.5 * Math.sin((nx * 70 + depth * 18) * (0.4 + depth));
        const field = fbm(nx * 6, depth * 4, seed + 9, 4);
        lum[i] = Math.min(1, 0.18 + field * 0.55 + furrows * 0.12 * depth - depth * 0.15);
        ground[i] = 1;
      }
    }
  }
  return { w, h, lum, ground };
}

function draw(ctx: CanvasRenderingContext2D, img: ImageData, f: Field, band: number | null) {
  const px = img.data;
  const { w, h, lum, ground } = f;
  const span = w + h;
  for (let y = 0; y < h; y++) {
    const row = (y & 7) << 3;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = BAYER[row + (x & 7)]!;
      let l = lum[i]!;
      if (band !== null) {
        const d = (x + y) / span - band;
        l += 0.28 * Math.exp(-(d * d) / 0.0035);
      }
      const isGround = ground[i]! > t;
      const hi = l > t;
      const c = isGround ? (hi ? PALETTE.sand : PALETTE.olive) : hi ? PALETTE.cloud : PALETTE.sky;
      const o = i << 2;
      px[o] = c[0];
      px[o + 1] = c[1];
      px[o + 2] = c[2];
      px[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

export function DitherBackground({ className, seed = 7 }: { className?: string; seed?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let field: Field | undefined;
    let img: ImageData | undefined;
    let raf = 0;
    let visible = true;
    let last = 0;
    const PERIOD = 14000;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const cell = Math.max(1, Math.round(2 * dpr)) / dpr;
      const w = Math.max(1, Math.ceil(rect.width / cell));
      const h = Math.max(1, Math.ceil(rect.height / cell));
      canvas.width = w;
      canvas.height = h;
      field = buildField(w, h, seed);
      img = ctx.createImageData(w, h);
      draw(ctx, img, field, null);
      canvas.dataset.ready = "true";
    };

    const frame = (now: number) => {
      raf = 0;
      if (!field || !img || !visible || document.hidden || reduced.matches) return;
      if (now - last > 66) {
        last = now;
        const phase = (now % PERIOD) / PERIOD;
        draw(ctx, img, field, phase * 1.6 - 0.3);
      }
      raf = requestAnimationFrame(frame);
    };
    const start = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };

    resize();
    start();
    const ro = new ResizeObserver(() => {
      resize();
      start();
    });
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => {
      visible = Boolean(e?.isIntersecting);
      if (visible) start();
    });
    io.observe(canvas);
    const onVis = () => !document.hidden && start();
    document.addEventListener("visibilitychange", onVis);
    reduced.addEventListener("change", start);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      reduced.removeEventListener("change", start);
    };
  }, [seed]);

  return (
    <canvas
      ref={ref}
      aria-hidden
      data-testid="dither"
      className={cn("pointer-events-none size-full opacity-0 transition-opacity duration-700 [image-rendering:pixelated] data-[ready=true]:opacity-100", className)}
    />
  );
}
