/**
 * Apply drizzle/schema-sync.sql - an idempotent, additive, non-destructive
 * schema sync - to the database. Runs during the Vercel build (see
 * next.config.mjs), then scripts/verify-schema.ts gates the deploy.
 *
 * Unlike `drizzle-kit push`, this never diffs/introspects and never emits
 * DROP statements, so it can't generate the spurious destructive changes that
 * roll back a whole migration. Every statement in the .sql is guarded
 * (IF NOT EXISTS / pg_constraint check), so a clean run applies atomically.
 *   DATABASE_URL_UNPOOLED=... npx tsx scripts/sync-schema.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) { console.error("[schema] DATABASE_URL not set"); process.exit(1); }

  const sql = readFileSync(join(process.cwd(), "drizzle", "schema-sync.sql"), "utf8");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    console.log("[schema] applying idempotent schema sync (drizzle/schema-sync.sql)...");
    await client.query(sql);
    console.log("[schema] schema sync applied");
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error("[schema] sync failed:", e.message); process.exit(1); });
