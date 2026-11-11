// Ported from apps/web/src/components/dither-background.tsx: a procedural landscape (sky, cumulus,
// hills, fields) rendered as an 8×8 Bayer ordered dither in four colours, with a slow light sweep.
(() => {
  const BAYER = [
    0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22, 3, 35, 11,
    43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21,
  ].map((v) => (v + 0.5) / 64);
  const P = { sky: [74, 146, 222], cloud: [178, 206, 232], olive: [138, 168, 78], sand: [222, 196, 122] };

  const hash = (x, y, s) => {
    let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  const noise = (x, y, s) => {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
  const fbm = (x, y, s, o = 5) => {
    let sum = 0, amp = 0.5, f = 1;
    for (let i = 0; i < o; i++) { sum += amp * noise(x * f, y * f, s + i * 17); f *= 2; amp *= 0.5; }
    return sum;
  };

  function build(w, h, seed) {
    const lum = new Float32Array(w * h), ground = new Float32Array(w * h), hills = new Float32Array(w);
    const k = 1 / Math.max(w, 1);
    for (let x = 0; x < w; x++) { const nx = x * k; hills[x] = 0.6 + 0.07 * fbm(nx * 3, 0.5, seed + 3, 4) - 0.035 * Math.sin(nx * 5.2 + 1.3); }
    for (let y = 0; y < h; y++) {
      const ny = y / h;
      for (let x = 0; x < w; x++) {
        const i = y * w + x, nx = x * k, hz = hills[x];
        if (ny < hz) {
          const ht = ny / hz;
          const billow = Math.max(0, fbm(nx * 4.2, ny * 7.5, seed, 5) - 0.47) * 2.6 * (1 - ht * 0.55);
          lum[i] = Math.min(1, 0.12 + ht * 0.3 + billow);
          ground[i] = Math.max(0, (ny - hz + 0.02) / 0.02);
        } else {
          const dp = (ny - hz) / (1 - hz);
          const furrows = 0.5 + 0.5 * Math.sin((nx * 70 + dp * 18) * (0.4 + dp));
          lum[i] = Math.min(1, 0.18 + fbm(nx * 6, dp * 4, seed + 9, 4) * 0.55 + furrows * 0.12 * dp - dp * 0.15);
          ground[i] = 1;
        }
      }
    }
    return { w, h, lum, ground };
  }

  function draw(ctx, img, f, band) {
    const px = img.data, { w, h, lum, ground } = f, span = w + h;
    for (let y = 0; y < h; y++) {
      const row = (y & 7) << 3;
      for (let x = 0; x < w; x++) {
        const i = y * w + x, t = BAYER[row + (x & 7)];
        let l = lum[i];
        if (band !== null) { const d = (x + y) / span - band; l += 0.28 * Math.exp(-(d * d) / 0.0035); }
        const c = ground[i] > t ? (l > t ? P.sand : P.olive) : l > t ? P.cloud : P.sky;
        const o = i << 2;
        px[o] = c[0]; px[o + 1] = c[1]; px[o + 2] = c[2]; px[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  const canvas = document.querySelector("canvas.dither");
  const ctx = canvas && canvas.getContext("2d", { alpha: false });
  if (!ctx) return;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const PERIOD = 14000;
  let field, img, raf = 0, last = 0, visible = true, lastW = 0, lastH = 0;

  const resize = () => {
    const r = canvas.getBoundingClientRect(), dpr = devicePixelRatio || 1;
    const cell = Math.max(1, Math.round(2 * dpr)) / dpr;
    const w = Math.max(1, Math.ceil(r.width / cell)), h = Math.max(1, Math.ceil(r.height / cell));
    if (w === lastW && h === lastH) return;
    lastW = w; lastH = h;
    canvas.width = w; canvas.height = h;
    field = build(w, h, 7);
    img = ctx.createImageData(w, h);
    draw(ctx, img, field, null);
    canvas.dataset.ready = "";
  };
  const frame = (now) => {
    raf = 0;
    if (!field || !visible || document.hidden || reduced.matches) return;
    if (now - last > 66) { last = now; draw(ctx, img, field, ((now % PERIOD) / PERIOD) * 1.6 - 0.3); }
    raf = requestAnimationFrame(frame);
  };
  const start = () => { if (!raf) raf = requestAnimationFrame(frame); };

  resize();
  start();
  new ResizeObserver(() => { resize(); start(); }).observe(canvas);
  new IntersectionObserver(([e]) => { visible = !!(e && e.isIntersecting); if (visible) start(); }).observe(canvas);
  document.addEventListener("visibilitychange", () => !document.hidden && start());
  reduced.addEventListener("change", start);
})();
