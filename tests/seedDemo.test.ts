// Two static guards on the demo workspace seeder, both for failures that only
// show up in somebody else's production database.
//
// The first is removal. `scripts/seed-demo.ts --wipe` promises to take the
// whole workspace back out, and the cascade cannot be trusted to do it:
// drizzle/schema-sync.sql is an additive, hand-mirrored DDL that does not carry
// a foreign key for every relation src/db/schema.ts declares, so a table added
// to the seed and forgotten in the wipe leaves rows pointing at an organization
// that no longer exists. Reading the source is the only way to catch that
// before a customer does.
//
// The second is mail. Every person the seed invents has to sit on a domain that
// cannot receive anything, so a buyer clicking through a demo cannot send a
// reminder, a quote or a digest to a real stranger.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SEED = join(process.cwd(), "scripts/seed-demo.ts");
const src = readFileSync(SEED, "utf8");

/** Every table the seed writes to, by its schema export name. */
const inserted = [...new Set([...src.matchAll(/db\.insert\((\w+)\)/g)].map((m) => m[1]))].sort();

/** The body of `async function wipe(...)`, up to its closing brace at column 0. */
function wipeBody(): string {
  const at = src.indexOf("async function wipe(");
  expect(at, "scripts/seed-demo.ts has no wipe()").toBeGreaterThan(-1);
  const end = src.indexOf("\n}\n", at);
  return src.slice(at, end === -1 ? src.length : end);
}

describe("the demo seeder", () => {
  it("writes to something", () => {
    // If this ever reads zero the two guards below are vacuously true, which is
    // the one way a static test can lie.
    expect(inserted.length).toBeGreaterThan(50);
  });

  it("removes every table it seeds", () => {
    const body = wipeBody();
    // app_settings is the instance singleton - the seed may flip a module flag
    // on it and says so, but it is nobody's row to delete.
    const notOurs = new Set(["appSettings"]);
    const missing = inserted.filter((t) => !notOurs.has(t) && !new RegExp(`\\b${t}\\b`).test(body));
    expect(missing, `seeded but never removed by --wipe:\n${missing.join("\n")}`).toEqual([]);
  });

  it("stamps its tenant on every insert that carries one", () => {
    // The same rule tests/tenantStamp.test.ts enforces across src/, applied
    // here rather than by widening that test's walk: the OLDER seed
    // (scripts/seed.ts) predates tenancy and writes deliberately unstamped rows
    // for a single-house instance, so the shared guard would fail on it for a
    // reason that is not a bug. The stamped list is read out of the schema, so
    // a table gaining the column starts being checked here with no edit.
    const schema = readFileSync(join(process.cwd(), "src/db/schema.ts"), "utf8");
    const stamped = new Set([...schema.matchAll(/export const (\w+) = pgTable\("(\w+)", \{([\s\S]*?)\n\}/g)]
      .filter((m) => /tenant_org_id|tenantStamp\(\)/.test(m[3]))
      .map((m) => m[1]));
    expect(stamped.size, "no stamped tables found - the pattern stopped matching").toBeGreaterThan(30);

    const missing: string[] = [];
    for (const table of inserted) {
      if (!stamped.has(table)) continue;
      // One insert statement: from `db.insert(x)` to its closing `;`.
      let at = src.indexOf(`db.insert(${table})`);
      while (at !== -1) {
        const end = src.indexOf(";", at);
        const stmt = src.slice(at, end === -1 ? src.length : end);
        if (!/tenantOrgId/.test(stmt)) missing.push(`${stmt.slice(0, 90).replace(/\s+/g, " ")}`);
        at = src.indexOf(`db.insert(${table})`, at + table.length);
      }
    }
    expect(missing, `insert without a tenant stamp:\n${missing.join("\n")}`).toEqual([]);
  });

  it("invents nobody at a deliverable address", () => {
    const allowed = /(\.example|@example\.com|@ridgelinefield\.com)$/;
    const found = [...new Set([...src.matchAll(/[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9.-]*\.[a-z]{2,}/gi)]
      .map((m) => m[0].toLowerCase()))];
    expect(found.length, "no addresses found - the pattern stopped matching").toBeGreaterThan(5);
    const reachable = found.filter((e) => !allowed.test(e));
    expect(reachable, `these could reach a real inbox:\n${reachable.join("\n")}`).toEqual([]);
  });
});
