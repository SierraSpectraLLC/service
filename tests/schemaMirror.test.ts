import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@/db/schema";

/**
 * The same guard as scripts/check-schema-mirror.ts, run with the test suite -
 * because a deploy already failed on a schema.ts column nobody mirrored into
 * drizzle/schema-sync.sql. The standalone script only helps when somebody
 * remembers to run it; this fails `npm test`, which everybody runs.
 */
describe("the schema mirror", () => {
  it("declares every schema.ts column in drizzle/schema-sync.sql", () => {
    const sql = readFileSync(join(process.cwd(), "drizzle", "schema-sync.sql"), "utf8");

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
    for (const exported of Object.values(schema)) {
      if (!(exported instanceof PgTable)) continue;
      const cfg = getTableConfig(exported);
      const have = declared.get(cfg.name);
      for (const col of cfg.columns) {
        if (!have?.has(col.name)) missing.push(`${cfg.name}.${col.name}`);
      }
    }
    // Each entry needs a guarded CREATE TABLE / ADD COLUMN IF NOT EXISTS in
    // drizzle/schema-sync.sql - see that file's header for the rules.
    expect(missing).toEqual([]);
  });
});
