// Guided demo: a click-through tour of the app, built from screenshots of the built-in demo data.
// Opens from any [data-tour] button, or from a link to #demo.
(() => {
  // Hotspot positions are percentages of the 1440x900 screenshot.
  const STEPS = [
    {
      name: "Repos", shot: "repos", url: "/repos",
      title: "Choose what elevate can see, and what it can touch.",
      body: "elevate syncs your GitHub repos and profiles each one you watch: its stack, its domains and what it is for. Reading and writing are separate switches, and both are off until you turn them on.",
      spots: [
        { x: 80.7, y: 33, text: "Watch: elevate reads the repo, profiles it and looks for techniques that fit it." },
        { x: 88, y: 69, text: "Swarms: only repos with this on can ever be written to." },
        { x: 59.5, y: 53.7, text: "The profile: the stack and domains that later drive the searches." },
        { x: 45, y: 77.4, text: "What is waiting on each repo: recommendations and open PRs." },
        { x: 83.5, y: 8.9, text: "Sync pulls the current repo list from GitHub." },
      ],
    },
    {
      name: "Radar", shot: "radar", url: "/radar",
      title: "Everything new, scored before it reaches you.",
      body: "Feeds you choose, plus searches built from each watched repo's profile, bring in new techniques. Each one gets a legitimacy score. Hype is kept, but filtered out of your way, with the reasons it failed.",
      spots: [
        { x: 36, y: 14.4, text: "Search terms come from your repos, so results fit the code you actually have." },
        { x: 91, y: 25.7, text: "Each feed carries a credibility score. Add any RSS or Atom feed." },
        { x: 56, y: 32.5, text: "Legit and hype are separate tabs. Nothing is thrown away." },
        { x: 56.5, y: 40.8, text: "A technique shows which of your repos it matched." },
      ],
    },
    {
      name: "Inbox", shot: "home", url: "/",
      title: "One place to see what is worth doing.",
      body: "The inbox only holds recommendations that passed both gates. The live map shows your watched repos, the techniques matched to them, and anything a swarm is working on right now.",
      spots: [
        { x: 61.5, y: 36.3, text: "A repo with a recommendation waiting for your call." },
        { x: 89.5, y: 66.5, text: "A technique matched to a repo." },
        { x: 31, y: 88, text: "Counts for what is ready, watched, found and already opened as a draft PR." },
        { x: 16.6, y: 10, text: "The number of recommendations waiting in the inbox." },
      ],
    },
    {
      name: "Recommendation", shot: "recommendation", url: "/r/…",
      title: "The evidence, laid out before you decide.",
      body: "Every recommendation says what would change, why it fits this repo, the expected impact and how that impact will be measured. Both gates show their score and the evidence behind it.",
      spots: [
        { x: 26.3, y: 18.4, text: "Overall score, from both gates." },
        { x: 70.5, y: 35.3, text: "The proposed change, the fit with this repo, effort and risk." },
        { x: 46.5, y: 64.8, text: "Gate 1: is the technique legit? Sources, corroboration, public code." },
        { x: 80, y: 57.3, text: "The original sources, one click away." },
        { x: 57, y: 23.3, text: "Nothing happens until you approve. You can also reject or re-verify." },
      ],
    },
    {
      name: "Swarm", shot: "swarm", url: "/swarms/…",
      title: "Approve once. A team of agents does the work.",
      body: "A planner splits the change into tasks. Implementers make it, a tester runs the before/after measure, and a reviewer on a second model checks the diff. Then a guarded publisher opens a draft PR.",
      spots: [
        { x: 23.5, y: 23, text: "The plan: planner, implementers, tester, reviewer, publisher." },
        { x: 32.5, y: 20.3, text: "Every swarm runs within a budget of tasks, minutes and turns." },
        { x: 60, y: 55, text: "A live log of each step as it runs." },
        { x: 81.8, y: 43.3, text: "Every write goes through a guard and is recorded here." },
        { x: 80.8, y: 10.2, text: "The result is a draft PR. elevate never pushes to a default branch." },
      ],
    },
    {
      name: "Swarms", shot: "swarms", url: "/swarms",
      title: "Every run, with its outcome.",
      body: "Every swarm ends in a pull request or a clear failure. elevate follows each PR's checks, and merges only once they pass: when you click Merge, or on its own if you switch auto-merge on in Settings.",
      spots: [
        { x: 51.5, y: 22.4, text: "Each run, with its repo and the executor that carried it out." },
        { x: 79, y: 27.6, text: "The state of its pull request. Here the checks have passed." },
        { x: 86.7, y: 27.6, text: "How the swarm itself ended." },
      ],
    },
    {
      name: "Chat", shot: "chat", url: "/chat",
      title: "Ask about your repos and the radar.",
      body: "Chat answers from the same data the app uses, through tools you can see. The model list comes from your Copilot account, and you can pick a different model for each conversation.",
      spots: [
        { x: 52.5, y: 20.8, text: "Tool calls are shown, so you can see where an answer came from." },
        { x: 67.5, y: 57.8, text: "Pick the model for this conversation." },
        { x: 29.6, y: 8, text: "Conversations are kept and listed here." },
      ],
    },
    {
      name: "Settings", shot: "settings", url: "/settings",
      title: "Your models, your thresholds, your limits.",
      body: "Pick the provider and models, and choose which products you want to hear about. Further down the same page: the GitHub connection, how strict each gate is, swarm budgets and auto-merge, the proved policy kernel and the audit log.",
      spots: [
        { x: 35.5, y: 18.4, text: "Runs on your Copilot subscription, or bring your own key for Anthropic, OpenAI or Azure." },
        { x: 50, y: 37.5, text: "One model for the background agents: triage, the gates and the swarm planner." },
        { x: 64, y: 37.5, text: "A separate default for chat." },
        { x: 42.8, y: 65.7, text: "Only news and recommendations for tools you can actually use are raised." },
      ],
    },
    {
      name: "Command palette", shot: "palette", url: "/",
      title: "Everything is one shortcut away.",
      body: "Press Ctrl+K (⌘K on a Mac) anywhere in the app. Dark and light themes follow your system until you pick one.",
      spots: [
        { x: 67, y: 20.8, text: "Search repos by stack or domain, techniques and recommendations." },
        { x: 34, y: 26.2, text: "Jump to any page." },
        { x: 34.6, y: 53.3, text: "Run actions: sweep the sources now, sync repos, switch theme." },
      ],
    },
    {
      name: "Phone", phones: ["inbox", "recommendation", "radar"], url: "on your phone",
      title: "Approve a change from wherever you are.",
      body: "The same app works on a small screen: a tab bar within thumb reach, lists that scroll sideways instead of breaking the page, and controls big enough to tap.",
      spots: [],
    },
  ];
  const DWELL = 9000; // ms per step while playing

  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else n.setAttribute(k, v);
    }
    n.append(...kids);
    return n;
  };
  const icon = (d) => {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", d);
    s.append(p);
    return s;
  };
  const I = {
    close: "M6 6l12 12M18 6L6 18",
    prev: "M15 5l-7 7 7 7",
    next: "M9 5l7 7-7 7",
    play: "M8 5.5v13l11-6.5z",
    pause: "M8 5v14M16 5v14",
  };

  let dlg, chips, stage, url, kicker, title, body, list, playBtn, prevBtn, nextBtn, endCta;
  let i = 0, playing = false, opener = null;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const src = (name, theme) => `images/${name}-${theme}.png`;
  const preload = (s) => {
    if (!s) return;
    const names = s.phones ? s.phones.map((p) => `phone-${p}`) : [s.shot];
    for (const n of names) for (const t of ["dark", "light"]) new Image().src = src(n, t);
  };

  function build() {
    chips = el("ol", { class: "tour-chips" });
    STEPS.forEach((s, n) => {
      const b = el("button", { type: "button", class: "tour-chip" }, el("span", { text: s.name }));
      b.addEventListener("click", () => go(n));
      // The active chip's fill animation doubles as the autoplay timer.
      b.addEventListener("animationend", () => { if (playing) i < STEPS.length - 1 ? go(i + 1, true) : setPlaying(false); });
      chips.append(el("li", {}, b));
    });

    const close = el("button", { type: "button", class: "icon-btn", "aria-label": "Close the demo", title: "Close (Esc)" }, icon(I.close));
    close.addEventListener("click", () => dlg.close());

    url = el("span");
    stage = el("div", { class: "tour-shot" });
    const frame = el("figure", { class: "frame tour-frame" },
      el("div", { class: "chrome", "aria-hidden": "true" }, el("i"), el("i"), el("i"), url),
      stage);

    kicker = el("p", { class: "eyebrow" });
    title = el("h2", { id: "tour-title" });
    body = el("p", { class: "tour-body" });
    list = el("ol", { class: "tour-list" });

    prevBtn = el("button", { type: "button", class: "btn tour-nav", "aria-label": "Previous step" }, icon(I.prev));
    nextBtn = el("button", { type: "button", class: "btn primary tour-next" }, el("span", { text: "Next" }), icon(I.next));
    playBtn = el("button", { type: "button", class: "btn tour-nav" });
    endCta = el("a", { class: "btn primary tour-next", href: "https://github.com/Bakar404/elevate#quick-start" }, el("span", { text: "Get started" }), icon(I.next));
    prevBtn.addEventListener("click", () => go(i - 1));
    nextBtn.addEventListener("click", () => go(i + 1));
    playBtn.addEventListener("click", () => setPlaying(!playing));

    const panel = el("div", { class: "tour-panel", "aria-live": "polite" }, kicker, title, body, list);
    const controls = el("div", { class: "tour-controls" }, prevBtn, playBtn, nextBtn, endCta);

    dlg = el("dialog", { class: "tour", "aria-labelledby": "tour-title" },
      el("header", { class: "tour-top" },
        el("span", { class: "tour-brand" }, el("img", { src: "images/logo.svg", width: "20", height: "20", alt: "" }), el("b", { text: "elevate" }), el("span", { class: "tour-badge", text: "demo" })),
        chips, close),
      el("div", { class: "tour-main" }, frame, el("aside", { class: "tour-side" }, panel, controls)),
      el("p", { class: "tour-foot", text: "Screens show the built-in demo repos. Use ← → to move, space to play or pause." }));

    dlg.addEventListener("keydown", (e) => {
      if (e.target.closest("a")) return;
      if (e.key === "ArrowRight") { e.preventDefault(); go(i + 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(i - 1); }
      else if (e.key === " " && !e.target.closest("button")) { e.preventDefault(); setPlaying(!playing); }
    });
    dlg.addEventListener("close", () => {
      setPlaying(false);
      document.documentElement.classList.remove("tour-open");
      if (location.hash === "#demo") history.replaceState(null, "", location.pathname + location.search);
      opener?.focus();
    });
    document.body.append(dlg);
  }

  function setPlaying(on) {
    playing = on;
    dlg.classList.toggle("playing", on);
    playBtn.replaceChildren(icon(on ? I.pause : I.play));
    playBtn.setAttribute("aria-label", on ? "Pause the demo" : "Play the demo");
    playBtn.title = on ? "Pause (space)" : "Play (space)";
    if (on) restartFill();
  }

  // Restart the active chip's fill from zero.
  function restartFill() {
    const b = chips.querySelector(".on");
    if (!b) return;
    b.classList.remove("on");
    void b.offsetWidth;
    b.classList.add("on");
  }

  function mark(n, on) {
    stage.querySelectorAll(".tour-spot")[n]?.classList.toggle("hot", on);
    list.children[n]?.classList.toggle("hot", on);
  }

  function go(n, auto = false) {
    if (n < 0 || n >= STEPS.length) return;
    i = n;
    const s = STEPS[i];
    // A manual move on the last step, or reaching it, stops autoplay there.
    if (!auto && playing && i === STEPS.length - 1) setPlaying(false);

    chips.querySelectorAll(".tour-chip").forEach((b, k) => {
      b.classList.toggle("on", k === i);
      b.classList.toggle("done", k < i);
      if (k === i) { b.setAttribute("aria-current", "step"); b.scrollIntoView({ block: "nearest", inline: "center" }); }
      else b.removeAttribute("aria-current");
    });
    if (playing) restartFill();

    url.textContent = s.phones ? s.url : `localhost:3100${s.url}`;
    kicker.textContent = `Step ${i + 1} of ${STEPS.length} · ${s.name}`;
    title.textContent = s.title;
    body.textContent = s.body;

    stage.classList.remove("show");
    stage.classList.toggle("phones-shot", !!s.phones);
    const kids = [];
    const img = (name, alt) => ["dark", "light"].map((t) => el("img", { class: `only-${t}`, src: src(name, t), alt, draggable: "false" }));
    if (s.phones) {
      for (const p of s.phones) kids.push(el("div", { class: "tour-phone" }, ...img(`phone-${p}`, `The ${p} screen on a phone`)));
    } else {
      kids.push(...img(s.shot, `${s.name} screen: ${s.title}`));
      s.spots.forEach((sp, k) => {
        const b = el("button", { type: "button", class: "tour-spot", style: `left:${sp.x}%;top:${sp.y}%`, "aria-label": `${k + 1}. ${sp.text}` }, el("span", { text: String(k + 1) }));
        for (const [ev, on] of [["pointerenter", true], ["pointerleave", false], ["focus", true], ["blur", false]]) b.addEventListener(ev, () => mark(k, on));
        kids.push(b);
      });
    }
    stage.replaceChildren(...kids);
    dlg.querySelector(".tour-main").scrollTop = 0;
    void stage.offsetWidth; // restart the fade for the new screen
    stage.classList.add("show");

    list.replaceChildren(...s.spots.map((sp, k) => {
      const li = el("li", {}, el("span", { class: "tour-num", text: String(k + 1) }), el("span", { text: sp.text }));
      li.addEventListener("pointerenter", () => mark(k, true));
      li.addEventListener("pointerleave", () => mark(k, false));
      return li;
    }));

    const last = i === STEPS.length - 1;
    prevBtn.disabled = i === 0;
    nextBtn.hidden = last;
    endCta.hidden = !last;
    preload(STEPS[i + 1]);
  }

  function open(from) {
    if (!dlg) build();
    if (dlg.open) return;
    opener = from ?? null;
    document.documentElement.classList.add("tour-open");
    dlg.style.setProperty("--dwell", `${DWELL}ms`);
    dlg.showModal();
    go(0);
    setPlaying(!reduced);
    nextBtn.focus();
  }

  for (const b of document.querySelectorAll("[data-tour]")) {
    b.hidden = false;
    b.addEventListener("click", () => open(b));
  }
  const fromHash = () => { if (location.hash === "#demo") open(); };
  addEventListener("hashchange", fromHash);
  fromHash();
})();
