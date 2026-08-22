import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // Component tests are .tsx; tsconfig says jsx: preserve (Next transforms
  // it in the app), so the react plugin transforms it for tests.
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
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
