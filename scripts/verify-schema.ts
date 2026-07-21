/**
 * Post-push schema verification: every table/column defined in src/db/schema.ts
 * must exist in the live database. Run after drizzle-kit push during the build -
 * drizzle-kit can print errors yet exit 0, so this is the authoritative gate
 * that stops a deploy from shipping code against an incomplete schema.
 *   DATABASE_URL_UNPOOLED=... npx tsx scripts/verify-schema.ts
 */
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import pg from "pg";
import * as schema from "../src/db/schema";

async function main() {
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) { console.error("[schema] DATABASE_URL not set"); process.exit(1); }

  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const res = await client.query(
    "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'"
  );
  await client.end();
  const have = new Set(res.rows.map((r) => `${r.table_name}.${r.column_name}`));

  const missing: string[] = [];
  let checked = 0;
  for (const exported of Object.values(schema)) {
    if (!(exported instanceof PgTable)) continue;
    const cfg = getTableConfig(exported);
    for (const col of cfg.columns) {
      checked++;
      if (!have.has(`${cfg.name}.${col.name}`)) missing.push(`${cfg.name}.${col.name}`);
    }
  }

  if (missing.length) {
    console.error(`[schema] VERIFICATION FAILED - ${missing.length} missing column(s) the app needs:`);
    for (const m of missing) console.error(`  - ${m}`);
    console.error("[schema] the drizzle-kit push above did not fully apply; see its output for the error");
    process.exit(1);
  }
  console.log(`[schema] verified: all ${checked} schema columns exist in the database`);
}

main().catch((e) => { console.error("[schema] verification errored:", e.message); process.exit(1); });
