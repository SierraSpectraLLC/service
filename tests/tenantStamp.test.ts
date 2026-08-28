import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Static guard: every insert into a tenant-stamped table must set the stamp.
 *
 * A missed stamp does not throw. It writes a row that its own workspace cannot
 * see - the record exists, the audit line exists, and the page it belongs on is
 * empty - which is a bug found by a customer rather than by a test. Reading the
 * source is the only way to catch it before then, the same trick
 * tests/clientBundle.test.ts uses for a failure that also only shows up at
 * runtime.
 *
 * Fixing a failure here means adding `tenantOrgId:` to the insert. Which value:
 * a record hanging off a system or a unit takes THAT record's tenant (work done
 * on a system belongs to the company whose system it is, whoever did it); a
 * top-level record takes myTenantOrgId(u), the writer's own workspace.
 */
const STAMPED = [
  "instruments", "assets", "tasks", "pmSchedules", "pmPlans", "timeEntries", "attachments",
  "procedures", "vocabTerms", "stageDefs", "people", "stockrooms", "discussionPosts",
  "purchaseOrders", "partPrices", "eodUpdates", "remoteDevices", "auditLog",
  "cloudConnections", "serviceVisits", "workOrders", "orgSites", "partCatalog", "agreements",
  "catalogRefs", "validationDocs", "messageThreads", "folders", "dropLinks", "shareLinks",
  "rateCards", "expenses", "invoices", "payments", "invoiceFees", "promises",
  "disputes", "dunningEvents", "creditOverrides", "quotes", "expenseCategories", "expenseReports",
  "awards", "providerLinks", "clientShares", "referralFees", "leads",
  // Stamped for housekeeping only. Payroll's ACCESS runs off org_id and is
  // decided in lib/payroll - the stamp is deliberately not a permission there,
  // which is the one place in the app where those two come apart.
  "payroll",
  // Perks are the payroll family: stamped for housekeeping, gated by
  // lib/payroll's employer-only rule rather than by the stamp.
  "perks",
];

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") || p.endsWith(".tsx") ? [p] : [];
  });

/** The text of one insert statement: from `db.insert(x)` to its closing `;`. */
function statements(src: string, table: string): string[] {
  const out: string[] = [];
  const needle = `db.insert(${table})`;
  let at = src.indexOf(needle);
  while (at !== -1) {
    const end = src.indexOf(";", at);
    out.push(src.slice(at, end === -1 ? src.length : end));
    at = src.indexOf(needle, at + needle.length);
  }
  return out;
}

describe("every stamped insert carries its tenant", () => {
  const files = walk(join(process.cwd(), "src"));

  for (const table of STAMPED) {
    it(`${table}`, () => {
      const missing: string[] = [];
      for (const file of files) {
        const src = readFileSync(file, "utf8");
        for (const stmt of statements(src, table)) {
          if (!/tenantOrgId/.test(stmt)) {
            missing.push(`${file.replace(process.cwd() + "/", "")}: ${stmt.slice(0, 90).replace(/\s+/g, " ")}`);
          }
        }
      }
      expect(missing, `insert without a tenant stamp:\n${missing.join("\n")}`).toEqual([]);
    });
  }

  it("is watching every table that has the column", async () => {
    // A new stamped table must be added to STAMPED above, or this guard would
    // quietly stop covering the newest thing anybody built.
    const schema = readFileSync(join(process.cwd(), "src/db/schema.ts"), "utf8");
    const withStamp = [...schema.matchAll(/export const (\w+) = pgTable\("(\w+)", \{([\s\S]*?)\n\}/g)]
      .filter((m) => /tenant_org_id|tenantStamp\(\)/.test(m[3]))
      .map((m) => m[1]);
    expect([...withStamp].sort()).toEqual([...STAMPED].sort());
  });
});
