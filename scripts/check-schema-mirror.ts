/**
 * Static guard: every table/column defined in src/db/schema.ts must be
 * mirrored in drizzle/schema-sync.sql. Unlike scripts/verify-schema.ts (which
 * checks the live database after the sync runs, at deploy time), this needs no
 * database, so CI can catch a forgotten mirror before anything deploys.
 *   npx tsx scripts/check-schema-mirror.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../src/db/schema";

const sql = readFileSync(join(process.cwd(), "drizzle", "schema-sync.sql"), "utf8");

// Collect the column names declared for each table, from both its CREATE TABLE
// block and any ALTER TABLE ... ADD COLUMN heal lines.
const declared = new Map<string, Set<string>>();
const cols = (table: string) => {
  let s = declared.get(table);
  if (!s) declared.set(table, (s = new Set()));
  return s;
};
for (const m of sql.matchAll(/CREATE TABLE IF NOT EXISTS "(\w+)" \(([\s\S]*?)\n\);/g)) {
  for (const c of m[2].matchAll(/^\s*"(\w+)"/gm)) cols(m[1]).add(c[1]);
}
for (const m of sql.matchAll(/ALTER TABLE "(\w+)" ADD COLUMN IF NOT EXISTS "(\w+)"/g)) {
  cols(m[1]).add(m[2]);
}

const missing: string[] = [];
let checked = 0;
for (const exported of Object.values(schema)) {
  if (!(exported instanceof PgTable)) continue;
  const cfg = getTableConfig(exported);
  const have = declared.get(cfg.name);
  for (const col of cfg.columns) {
    checked++;
    if (!have?.has(col.name)) missing.push(`${cfg.name}.${col.name}`);
  }
}

if (missing.length) {
  console.error(`[schema-mirror] FAILED - ${missing.length} column(s) in src/db/schema.ts are not mirrored in drizzle/schema-sync.sql:`);
  for (const m of missing) console.error(`  - ${m}`);
  console.error("[schema-mirror] add a guarded CREATE TABLE / ADD COLUMN IF NOT EXISTS for each (see the file header rules)");
  process.exit(1);
}
console.log(`[schema-mirror] OK - ${checked} columns all mirrored`);
