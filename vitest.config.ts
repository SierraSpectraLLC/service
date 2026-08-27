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
    /*
     * A dozen suites open an in-process Postgres and apply the whole of
     * drizzle/schema-sync.sql in beforeAll. That file only grows - it is
     * additive-only by design, since it is what every deploy runs - and at
     * ~3,400 lines it takes most of vitest's 10s default when a dozen of them
     * are doing it on the same cores at once. The failure looked like two
     * random suites erroring and passed on a re-run, which is the worst kind
     * of red: nobody believes the next one either.
     */
    hookTimeout: 60_000,
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
