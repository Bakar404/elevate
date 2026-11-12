import { expect, test, type Page } from "@playwright/test";

type Rec = { id: string; status: string; repo: string; title: string };

async function waitForOpenRecs(page: Page): Promise<Rec[]> {
  let open: Rec[] = [];
  await expect
    .poll(async () => {
      open = (await (await page.request.get("/api/recommendations?status=open")).json()) as Rec[];
      return open.length;
    }, { timeout: 90_000 })
    .toBeGreaterThan(0);
  return open;
}

test("inbox renders the dither background and only gated recommendations", async ({ page }) => {
  await waitForOpenRecs(page);
  await page.goto("/");
  await expect(page.getByTestId("demo-badge")).toBeVisible();
  const canvas = page.getByTestId("dither");
  await expect(canvas).toHaveAttribute("data-ready", "true");
  const painted = await canvas.evaluate((c: HTMLCanvasElement) => {
    const g = c.getContext("2d")!;
    const { data } = g.getImageData(0, 0, c.width, c.height);
    const colours = new Set<number>();
    for (let i = 0; i < data.length; i += 4 * 97) colours.add((data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!);
    return colours.size;
  });
  expect(painted).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId("rec-card").first()).toBeVisible();
  await expect(page.getByText(/weight-space/i)).toHaveCount(0);
});

test("home map shows watched repos; sidebar collapses and remembers it", async ({ page }) => {
  await waitForOpenRecs(page);
  await page.goto("/");
  await expect(page.getByTestId("activity-graph")).toBeVisible();
  await expect(page.locator('[data-testid="graph-repo"][data-state="review"]').first()).toBeVisible();
  const sidebar = page.getByTestId("sidebar");
  await expect(sidebar).toHaveAttribute("data-collapsed", "false");
  await page.getByTestId("sidebar-toggle").click();
  await expect(sidebar).toHaveAttribute("data-collapsed", "true");
  await page.reload();
  await expect(sidebar).toHaveAttribute("data-collapsed", "true");
  await page.keyboard.press("ControlOrMeta+b");
  await expect(sidebar).toHaveAttribute("data-collapsed", "false");
  await page.getByRole("link", { name: "Radar" }).click();
  await expect(page).toHaveURL(/\/radar/);
});

test("command palette opens with the keyboard and navigates", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.getByPlaceholder("Search repos by stack or domain, techniques, recommendations…");
  await expect(input).toBeVisible();
  await input.fill("radar");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/radar/);
  await expect(page.getByTestId("technique").first()).toBeVisible();
});

test.describe("theme", () => {
  test.use({ colorScheme: "light" });
  test("follows the OS on first visit, toggles, and is remembered", async ({ page }) => {
    const html = page.locator("html");
    const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await page.goto("/");
    await expect(html).toHaveClass(/\blight\b/);
    const light = await bg();
    await page.getByTestId("theme-toggle").click();
    await expect(html).toHaveClass(/\bdark\b/);
    expect(await bg()).not.toBe(light);
    await page.reload();
    await expect(html).toHaveClass(/\bdark\b/);
    await page.keyboard.press("ControlOrMeta+k");
    await page.getByPlaceholder("Search repos by stack or domain, techniques, recommendations…").fill("theme");
    await page.keyboard.press("Enter");
    await expect(html).toHaveClass(/\blight\b/);
    await page.reload();
    await expect(html).toHaveClass(/\blight\b/);
  });
});

test("hype is filtered on the radar with its reasons", async ({ page }) => {
  await page.goto("/radar?show=hype");
  await expect(page.getByText(/weight-space/i).first()).toBeVisible();
  await expect(page.getByText(/judged it not legitimate/i).first()).toBeVisible();
});

test("approve → allow repo → swarm → PR → verified → merge, with history and audit trail", async ({ page }) => {
  const [rec] = await waitForOpenRecs(page);
  await page.goto(`/r/${rec!.id}`);
  await expect(page.getByTestId("gate-legitimacy")).toContainText("passed");
  await expect(page.getByTestId("gate-soundness")).toContainText("passed");
  await page.getByTestId("approve").click();
  const allow = page.getByTestId("allow-repo");
  if (await allow.isVisible()) {
    await expect(page.getByTestId("launch")).toBeDisabled();
    await allow.click();
  }
  await page.getByTestId("launch").click();
  await expect(page.getByText("PR open").first()).toBeVisible({ timeout: 90_000 });
  await expect(page.locator('[data-testid="history"] [data-event="pr"]')).toBeVisible();

  await page.getByRole("link", { name: /fake · succeeded/ }).click();
  await expect(page.getByTestId("pr-link")).toHaveAttribute("href", /\/pull\//);
  await expect(page.getByTestId("task-graph")).toBeVisible();
  await expect(page.getByTestId("audits")).toContainText(rec!.repo);

  // elevate follows the PR. The fake's CI passes, so it's verified and waits for your Merge (auto-merge is off).
  const panel = page.getByTestId("pr-panel");
  await expect(panel).toBeVisible();
  if ((await panel.getAttribute("data-stage")) === "unchecked") await page.getByTestId("refresh-pr").click();
  await expect(panel).toHaveAttribute("data-stage", "ready");
  await expect(panel.locator('[data-check-state="passed"]')).toHaveCount(1);
  await expect(page.getByTestId("auto-merge-state")).toContainText("Auto-merge off");
  await page.getByTestId("merge-pr").click();
  await expect(panel).toHaveAttribute("data-stage", "merged");
  await expect(page.getByTestId("merge-pr")).toHaveCount(0);
  await expect(page.getByTestId("audits")).toContainText("merge_pr");

  await page.goto(`/r/${rec!.id}`);
  await expect(page.locator('[data-testid="history"] [data-event="merge"]')).toBeVisible();
  await expect(page.getByTestId("pr-panel")).toHaveAttribute("data-stage", "merged");

  const after = (await (await page.request.post(`/api/recommendations/${rec!.id}/approve`, { data: { executor: "fake" }, headers: { origin: new URL(page.url()).origin } })).status());
  expect(after).toBe(409);
});

test("chat streams an answer with tool calls", async ({ page }) => {
  await page.goto("/chat");
  await page.getByLabel("Message").fill("What should I upgrade first?");
  await page.getByLabel("Send").click();
  await expect(page.getByTestId("tool-chip").first()).toBeVisible();
  await expect(page.getByTestId("messages")).toContainText(/ledger-api|llm-router/);
});

test("chat model can be picked per conversation, and conversations can be deleted", async ({ page }) => {
  await page.goto("/chat");
  await page.getByRole("button", { name: "New chat" }).click();
  await page.getByTestId("model-picker").click();
  await page.getByRole("option", { name: /GPT-6 Luna/ }).click();
  await expect(page.getByTestId("model-picker")).toContainText("GPT-6 Luna");
  await page.getByLabel("Message").fill("list my repos please");
  await page.getByLabel("Send").click();
  await expect(page.getByTestId("messages")).toContainText("stand-in for gpt-6-luna");

  const row = page.getByTestId("thread").filter({ hasText: "list my repos please" });
  await expect(row).toHaveCount(1);
  await page.reload();
  await row.click();
  await expect(page.getByTestId("model-picker")).toContainText("GPT-6 Luna");

  await row.hover();
  await row.getByRole("button", { name: /Delete/ }).click();
  await expect(page.getByRole("dialog")).toContainText("Delete this conversation?");
  await page.getByTestId("confirm-delete").click();
  await expect(row).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("thread").filter({ hasText: "list my repos please" })).toHaveCount(0);
});

test("settings shows the proof receipt", async ({ page }) => {
  await page.goto("/settings");
  await expect(page.getByTestId("pipeline-model")).toBeVisible();
  await expect(page.getByTestId("chat-model")).toBeVisible();
  await expect(page.getByTestId("proof-card")).toContainText(/receipt: pass/i);
  await expect(page.getByTestId("proof-card")).toContainText("36 of 36 mutants");
  await expect(page.getByTestId("proof-card").locator("summary")).toHaveText("30 requirements");
});

test("the auto-merge switch is where the PR panel's link points", async ({ page }) => {
  await page.goto("/settings#auto-merge");
  const toggle = page.getByTestId("auto-merge");
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  await expect(toggle).toBeInViewport();
});

test("repo search matches by stack and domain, keeps state in the URL, and filters", async ({ page }) => {
  await page.goto("/repos");
  await expect(page.getByTestId("repo")).toHaveCount(3);
  await page.getByTestId("repo-search").fill("fintech postgres");
  await expect(page).toHaveURL(/q=fintech\+postgres/);
  await expect(page.getByTestId("repo")).toHaveCount(1);
  await expect(page.getByTestId("repo").first()).toContainText("demo/ledger-api");
  await page.reload();
  await expect(page.getByTestId("repo-search")).toHaveValue("fintech postgres");
  await expect(page.getByTestId("repo")).toHaveCount(1);
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(page.getByTestId("repo")).toHaveCount(3);
  await page.getByRole("tab", { name: /Swarms allowed/ }).click();
  await expect(page).toHaveURL(/f=swarm/);
  await page.getByTestId("repo-search").fill("zzz-no-such-repo");
  await expect(page.getByText("No repos match")).toBeVisible();
});

test("home and radar show what is being searched for each repo, and the feed scrolls", async ({ page }) => {
  await waitForOpenRecs(page);
  await page.goto("/");
  const plan = page.getByTestId("search-plan");
  await expect(plan).toBeVisible();
  for (const name of ["ledger-api", "llm-router", "edge-firmware"]) await expect(plan).toContainText(name);
  await page.getByTestId("fresh").scrollIntoViewIfNeeded();
  await expect(page.getByTestId("fresh").getByTestId("feed-item").first()).toBeVisible();
  await page.goto("/radar?show=feed");
  await expect(page.getByTestId("focus-sources")).toContainText("searches HN, arXiv and GitHub");
  await expect(page.getByTestId("feed-item").first()).toBeVisible();
});
test("swarm PRs are published as you by default, and that can be turned off", async ({ page }) => {
  await page.goto("/settings");
  const toggle = page.getByTestId("publish-as-me");
  await expect(toggle).toHaveAttribute("aria-checked", "true");
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/settings") && r.request().method() === "PUT");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-checked", "false");
  expect((await saved).ok()).toBe(true);
  await page.reload();
  await expect(page.getByTestId("publish-as-me")).toHaveAttribute("aria-checked", "false");
  const restored = page.waitForResponse((r) => r.url().endsWith("/api/settings") && r.request().method() === "PUT");
  await page.getByTestId("publish-as-me").click();
  await expect(page.getByTestId("publish-as-me")).toHaveAttribute("aria-checked", "true");
  await restored;
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  /** "" when the page fits; otherwise the overflow and the elements sticking out, so a failure names the culprit. */
  const overflow = (page: Page) =>
    page.evaluate(() => {
      const W = document.documentElement.clientWidth;
      const over = document.documentElement.scrollWidth - W;
      if (over <= 0) return "";
      const clipped = (el: Element) => {
        for (let a = el.parentElement; a; a = a.parentElement) if (getComputedStyle(a).overflowX !== "visible") return true;
        return false;
      };
      const out = [...document.querySelectorAll("body *")]
        .filter((el) => el.getBoundingClientRect().right > W + 0.5 && !clipped(el))
        .slice(0, 5)
        .map((el) => `<${el.tagName.toLowerCase()} class="${String(el.className).slice(0, 80)}"> "${(el.textContent ?? "").trim().slice(0, 40)}"`);
      return `${over}px wider than the screen: ${out.join(" | ")}`;
    });

  test("pages fit the screen and the tab bar replaces the sidebar", async ({ page }) => {
    await waitForOpenRecs(page);
    await page.goto("/");
    await expect(page.getByTestId("sidebar")).toBeHidden();
    await expect(page.getByTestId("mobile-topbar")).toBeVisible();
    const tabs = page.getByTestId("mobile-tabbar");
    for (const [name, url] of [["Radar", /\/radar$/], ["Repos", /\/repos$/], ["Swarms", /\/swarms$/], ["Settings", /\/settings$/], ["Inbox", /\/$/]] as const) {
      await tabs.getByRole("link", { name }).click();
      await expect(page).toHaveURL(url);
      await expect(tabs.getByRole("link", { name })).toHaveAttribute("aria-current", "page");
      expect(await overflow(page)).toBe("");
    }
    await page.getByTestId("rec-card").first().click();
    await expect(page).toHaveURL(/\/r\//);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await overflow(page)).toBe("");
  });

  test("chat history opens in a drawer", async ({ page }) => {
    await page.goto("/chat");
    await page.getByRole("button", { name: "New chat" }).click();
    await page.getByLabel("Message").fill("what is on the radar");
    await page.getByLabel("Send").click();
    await expect(page.getByTestId("messages").locator("[data-role=assistant]")).toHaveCount(1);
    await expect(page.getByTestId("messages").locator("[data-role=assistant]")).toContainText(/\w/);
    await page.getByTestId("threads-open").click();
    const row = page.getByTestId("thread-mobile").filter({ hasText: "what is on the radar" });
    await expect(row).toHaveCount(1);
    await expect(row.getByRole("button", { name: /Delete/ })).toBeVisible();
    await row.getByRole("button", { name: "what is on the radar", exact: true }).click();
    await expect(page.getByTestId("threads-drawer")).toHaveCount(0);
  });
});

test("news the workspace can't use is set aside with the reason, and the filter narrows the list", async ({ page }) => {
  await waitForOpenRecs(page);
  await page.goto("/radar?show=setaside");
  const cards = page.getByTestId("technique");
  await expect(cards).toHaveCount(3);
  await expect(page.getByTestId("access-reason").filter({ hasText: /GPT-5\.4 has been superseded/ })).toBeVisible();
  await expect(page.getByTestId("access-reason").filter({ hasText: /Needs Codex/ })).toBeVisible();
  await expect(page.getByTestId("access-strip")).toContainText("GitHub Copilot");
  await page.goto("/");
  await expect(page.getByText(/GPT-5\.4|Codex cloud/)).toHaveCount(0);
});

test("switching a product on in Settings releases what was held for it", async ({ page }) => {
  await waitForOpenRecs(page);
  await page.goto("/settings");
  const codex = page.getByTestId("access-codex");
  await expect(codex).toHaveAttribute("aria-checked", "false");
  await codex.click();
  await expect(codex).toHaveAttribute("aria-checked", "true");
  await page.goto("/radar?show=setaside");
  await expect(page.getByTestId("technique")).toHaveCount(2);
  await page.goto("/settings");
  await page.getByRole("button", { name: "Reset to detected" }).click();
  await expect(page.getByTestId("access-codex")).toHaveAttribute("aria-checked", "false");
});

test("sources can be managed from the radar, and Pip reports what's waiting", async ({ page }) => {
  await waitForOpenRecs(page);
  await page.goto("/radar");
  await page.getByTestId("manage-sources").click();
  const list = page.getByTestId("source-list");
  await expect(list.getByText("Hacker News")).toBeVisible();
  await page.getByLabel("Feed name").fill("My feed");
  await page.getByLabel("Feed URL").fill("https://example.com/feed.xml");
  await page.getByRole("button", { name: "Add feed" }).click();
  await expect(list.getByText("My feed")).toBeVisible();
  await page.getByRole("button", { name: "Remove My feed" }).click();
  await expect(list.getByText("My feed")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await page.getByTestId("pip").getByRole("button").click();
  await expect(page.getByTestId("pip-bubble")).toContainText(/ready for you/);
});
