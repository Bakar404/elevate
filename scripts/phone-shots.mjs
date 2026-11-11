// Regenerates the website's phone screenshots (docs/images/phone-*.png) from a running demo.
//   ELEVATE_DEMO=1 pnpm dev        # in one terminal
//   pnpm --filter @elevate/web exec node ../../scripts/phone-shots.mjs [http://localhost:3100]
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const { chromium } = createRequire(`${process.cwd()}/`)("@playwright/test");
const base = process.argv[2] ?? "http://localhost:3100";
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "images");

const browser = await chromium.launch({ channel: process.env.E2E_CHANNEL || undefined });
try {
  for (const theme of ["dark", "light"]) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: theme });
    await ctx.addCookies([{ name: "elevate-theme", value: theme, url: base }]);
    const page = await ctx.newPage();
    const recs = await (await page.request.get(`${base}/api/recommendations?status=open`)).json();
    if (!recs.length) throw new Error("No open recommendations yet: wait for the demo pipeline to finish.");
    for (const [name, url] of [["inbox", "/"], ["recommendation", `/r/${recs[0].id}`], ["radar", "/radar"]]) {
      await page.goto(base + url, { waitUntil: "networkidle" });
      // The dev-mode indicator isn't part of the app.
      await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
      await page.waitForTimeout(1200);
      await page.screenshot({ path: path.join(out, `phone-${name}-${theme}.png`) });
      console.log(`phone-${name}-${theme}.png`);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
