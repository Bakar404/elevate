import { defineConfig } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "e2e",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${port}`,
    channel: process.env.E2E_CHANNEL ?? (process.env.CI ? undefined : "msedge"),
    trace: "retain-on-failure",
  },
  webServer: {
    command: `node -e "require('fs').rmSync('../../.data-e2e',{recursive:true,force:true})" && ${process.env.CI ? `next start --port ${port}` : `next dev --port ${port}`}`,
    url: `http://localhost:${port}/api/stats`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
    env: { ELEVATE_DEMO: "1", ELEVATE_DATA_DIR: ".data-e2e" },
  },
});
