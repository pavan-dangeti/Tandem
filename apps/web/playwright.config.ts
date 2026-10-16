import { defineConfig } from "@playwright/test";

const API = "http://127.0.0.1:8099";

// Runs against the production build so the content security policy is live.
export default defineConfig({
  testDir: "e2e",
  testMatch: "*.e2e.ts",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: "http://127.0.0.1:4179", trace: "retain-on-failure" },
  webServer: [
    {
      command: "pnpm exec tsx src/index.ts",
      cwd: "../server",
      env: { PORT: "8099" },
      url: `${API}/healthz`,
      reuseExistingServer: false,
    },
    {
      command:
        "vite build && vite preview --host 127.0.0.1 --port 4179 --strictPort",
      env: { VITE_API: API },
      url: "http://127.0.0.1:4179",
      reuseExistingServer: false,
    },
  ],
});
