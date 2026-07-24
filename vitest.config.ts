import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // Several modules under test (auth.ts, sheetSync.ts) transitively import
    // src/db/index.ts, which constructs the neon client at module load and
    // throws without a connection string. Tests never connect - these dummies
    // just let the imports succeed.
    env: {
      DATABASE_URL: "postgresql://test:test@test.local/test",
      AUTH_SECRET: "test-secret",
      AUTH_RESEND_KEY: "test-key",
      EMAIL_FROM: "test@example.com",
    },
  },
});
