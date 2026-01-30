import { defineConfig, devices } from "@playwright/test";

const repositoryRoot = "../..";
const apiOrigin = "http://127.0.0.1:8100";
const webOrigin = "http://127.0.0.1:3100";
const python = process.env.CI ? "python" : ".venv/bin/python";

export default defineConfig({
  testDir: "../../tests/e2e",
  outputDir: "../../tmp/playwright-results",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [
    ["line"],
    ["html", { outputFolder: "../../tmp/playwright-report", open: "never" }],
  ],
  use: {
    baseURL: webOrigin,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], acceptDownloads: true },
    },
  ],
  webServer: [
    {
      name: "API",
      command: `${python} -m alembic -c apps/api/alembic.ini upgrade head && ${python} -m uvicorn snapflow.main:create_app --factory --host 127.0.0.1 --port 8100 --log-level warning`,
      cwd: repositoryRoot,
      env: {
        APP_ENV: "test",
        DATABASE_URL:
          process.env.DATABASE_URL ??
          "postgresql+psycopg://snapflow:snapflow-local-only@127.0.0.1:5432/snapflow",
        GUEST_TOKEN_SIGNING_KEY: process.env.GUEST_TOKEN_SIGNING_KEY ?? "11".repeat(32),
        MODEL_PROVIDER: "mock",
      },
      url: `${apiOrigin}/health/live`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    },
    {
      name: "Web",
      command: "pnpm --filter @snapflow/web dev --hostname 127.0.0.1 --port 3100",
      cwd: repositoryRoot,
      env: {
        API_BASE_URL: apiOrigin,
      },
      url: `${webOrigin}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    },
  ],
});
