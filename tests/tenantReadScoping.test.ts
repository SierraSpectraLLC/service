// The sweep that found the leak, kept as a test.
//
// A demo workspace was opened on the live instance and its owner could read the
// real operator's files, staff, systems and contracts. Every one of those was
// the same shape: a select from a tenant-stamped table with no predicate at
// all, sitting behind a role check that reads true for EVERY operator's people
// - isStaffRole, isHouse, role === "owner". The role was never the scope.
//
// So this walks the schema for tables that carry tenantStamp(), finds every
// read of one that has no WHERE clause whatsoever, and requires each to be on
// the list below with a reason. It is deliberately crude: a read with any
// predicate passes, because judging whether a predicate is the RIGHT one is not
// something a regex can do. What it does catch is the unguarded enumeration -
// which is what every leak here actually was.
//
// Adding a line to ALLOWED is a normal thing to do. Doing it without being able
// to write the reason is the signal to stop.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * `path::table` -> why a whole-table read is correct there.
 *
 * Keyed on the PAIR, not the file. actions.ts is twelve thousand lines; letting
 * one justified read there bless every future one in the same file would empty
 * this guard out quietly, which is the failure mode it exists to prevent.
 */
const ALLOWED: Record<string, string> = {
  "src/app/api/cron/renewals/route.ts::agreements":
    "The platform's weekly sweep. Every agreement is chased by its OWN operator - " +
    "the loop mails houseEmails(a.tenantOrgId) - and nothing is rendered to a person.",
  "src/lib/recurringRun.ts::agreements":
    "Same: the recurring-billing cron, behind CRON_SECRET. Each cycle is raised " +
    "against its own agreement, which carries the stamp the invoice inherits.",
  "src/app/settings/tenants/page.tsx::instruments":
    "The platform owner's meter - seats, clients, systems and machines PER " +
    "workspace. Counting across tenants is the page's entire job, and " +
    "requirePlatformOwner is the gate that makes it the right person's job.",
  "src/app/settings/tenants/page.tsx::remoteDevices":
    "Same page, same meter: machines per workspace is one of the numbers a price " +
    "is built from.",
  "src/lib/clientShareData.ts::instruments":
    "Materializing an accepted client share mints a tag the RECIPIENT can use, " +
    "and instruments.external_id is UNIQUE(external_id) - not UNIQUE(tenant, " +
    "external_id) - so the collision check has to see the whole table or the " +
    "insert throws on somebody else's row. It reads external_id only, never a " +
    "row, and the tags it compares are exactly the ones the constraint compares. " +
    "Making that constraint per-tenant is the real fix and is a migration.",
  "src/lib/docNumberData.ts::purchaseOrders":
    "PO numbers are globally unique - po_number_unique is UNIQUE(number), not " +
    "UNIQUE(tenant, number) - so the scan that picks the next one has to see the " +
    "whole table or two workspaces climb into each other. It returns numbers, " +
    "never rows. Making the constraint per-tenant is the real fix and is a " +
    "migration; until then this read is load-bearing. It moved here from " +
    "app/actions when every document number came under one door.",
  "src/lib/eodEmail.ts::instruments":
    "Selects tenant_org_id explicitly and filters in JS: see mine() a few lines " +
    "down, applied to all three row sets before anything is grouped or sent.",
};

const SRC = "src";

/** Table constants in db/schema.ts declared with tenantStamp(). */
function stampedTables(): string[] {
  const sch = readFileSync("src/db/schema.ts", "utf8");
  const starts = [...sch.matchAll(/export const (\w+) = pgTable\(/g)]
    .map((m) => [m.index!, m[1]] as const);
  return starts
    .filter(([pos], i) => sch
      .slice(pos, i + 1 < starts.length ? starts[i + 1][0] : sch.length)
      .includes("tenantStamp()"))
    .map(([, name]) => name);
}

/**
 * Reads with no where clause at all. The statement is taken as the lines from
 * the .from() up to whatever plainly ends it - good enough for a chained
 * drizzle select, which never runs long.
 */
function nakedReads(tables: string[]): { file: string; table: string; line: number }[] {
  let out: string;
  try {
    out = execFileSync("grep", [
      "-rn", "--include=*.ts", "--include=*.tsx",
      "-E", String.raw`\.from\((${tables.join("|")})\)`, SRC,
    ], { encoding: "utf8" });
  } catch {
    return []; // grep exits 1 on no matches
  }
  const cache = new Map<string, string[]>();
  const hits: { file: string; table: string; line: number }[] = [];
  for (const row of out.split("\n").filter(Boolean)) {
    const [file, lineNo] = row.split(":", 2);
    const n = parseInt(lineNo);
    if (!cache.has(file)) cache.set(file, readFileSync(file, "utf8").split("\n"));
    const src = cache.get(file)!;
    const stmt: string[] = [];
    for (let i = n - 1; i < Math.min(n + 10, src.length); i++) {
      stmt.push(src[i]);
      const t = src[i].trimEnd();
      if (i > n - 1 && (t.endsWith(";") || t.endsWith("),") || t.endsWith(")]")
        || /^\s*(const|let|return|await|\}|\))/.test(src[i]))) break;
    }
    if (stmt.join("\n").includes(".where(")) continue;
    hits.push({ file, table: /\.from\((\w+)\)/.exec(src[n - 1])![1], line: n });
  }
  return hits;
}

describe("no tenant-stamped table is read across the whole instance by accident", () => {
  const tables = stampedTables();

  it("the schema still stamps the tables this test is about", () => {
    // A rename that emptied this list would turn the check below into a no-op
    // that passes forever, which is the worst way for a guard to fail.
    expect(tables.length).toBeGreaterThan(30);
    for (const t of ["invoices", "attachments", "instruments", "rateCards", "agreements"]) {
      expect(tables).toContain(t);
    }
  });

  it("every unpredicated read is one somebody justified", () => {
    const unexplained = nakedReads(tables).filter((h) => !(`${h.file}::${h.table}` in ALLOWED));
    expect(unexplained.map((h) => `${h.file}:${h.line} reads all of ${h.table}`)).toEqual([]);
  });

  it("the allowlist has no stale entries", () => {
    // An entry left behind after its read was scoped would quietly re-bless the
    // next unscoped read added to that same file.
    const live = new Set(nakedReads(tables).map((h) => `${h.file}::${h.table}`));
    expect(Object.keys(ALLOWED).filter((k) => !live.has(k))).toEqual([]);
  });
});
