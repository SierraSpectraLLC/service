import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema";

const neonDb = () => drizzle(neon(process.env.DATABASE_URL!), { schema });

/**
 * LOCAL_DB=1 under `next dev` swaps Neon for an in-process PGlite Postgres -
 * the throwaway database `npm run dev:local` (scripts/dev-local.ts) seeds and
 * boots against, so the real pages can be run and screenshotted with no
 * network and no credentials. Gated on NODE_ENV so a stray LOCAL_DB in a
 * production environment changes nothing; every other path through this
 * module is the Neon client it always was.
 */
function localDb(): ReturnType<typeof neonDb> {
  /**
   * ONE handle per process, parked on globalThis.
   *
   * PGlite is an embedded Postgres: two handles on one data directory are two
   * databases that happen to share a folder, and neither sees the other's
   * writes. Next's dev server loads this module more than once - the RSC graph
   * and the server-action graph are separate bundles - so without this the
   * action writes into one copy and the page that re-renders reads the other,
   * which looks exactly like a mutation silently not happening. It cost an
   * afternoon of chasing an invoice that would not leave draft.
   */
  const g = globalThis as typeof globalThis & { __ridgelineLocalDb?: ReturnType<typeof neonDb> };
  if (!g.__ridgelineLocalDb) {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { PGlite } = require("@electric-sql/pglite");
    const { drizzle: drizzlePglite } = require("drizzle-orm/pglite");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const client = new PGlite(process.env.PGLITE_DIR);
    // Same dialect, same drizzle query API; the cast keeps every call site
    // typed against the production client.
    g.__ridgelineLocalDb = drizzlePglite(client, { schema }) as unknown as ReturnType<typeof neonDb>;
  }
  return g.__ridgelineLocalDb;
}

export const db =
  process.env.NODE_ENV === "development" && process.env.LOCAL_DB === "1"
    ? localDb()
    : neonDb();
