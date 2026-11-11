(() => {
  const root = document.documentElement;
  const btn = document.getElementById("theme");
  const KEY = "elevate-site-theme";

  const label = () => btn.setAttribute("aria-label", root.dataset.theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
  label();
  btn.addEventListener("click", () => {
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try { localStorage.setItem(KEY, next); } catch (e) {}
    label();
  });
  // Follow the system until the visitor picks a theme.
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    let saved = null;
    try { saved = localStorage.getItem(KEY); } catch (err) {}
    if (!saved) { root.dataset.theme = e.matches ? "dark" : "light"; label(); }
  });

  // Spotlight cards (Aceternity-style): track the pointer.
  for (const card of document.querySelectorAll(".spot")) {
    card.addEventListener("pointermove", (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty("--x", `${e.clientX - r.left}px`);
      card.style.setProperty("--y", `${e.clientY - r.top}px`);
    });
  }

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Count numbers up once they scroll into view (NumberFlow-style).
  const count = (el) => {
    const to = Number(el.dataset.count), dec = Number(el.dataset.dec || 0);
    if (reduced) return;
    const t0 = performance.now(), dur = 1100;
    const step = (now) => {
      const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3);
      el.textContent = (to * e).toFixed(dec);
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  };

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      e.target.querySelectorAll("[data-count]").forEach(count);
      io.unobserve(e.target);
    }
  }, { rootMargin: "0px 0px -10% 0px" });
  document.querySelectorAll(".reveal").forEach((el) => io.observe(el));
})();
