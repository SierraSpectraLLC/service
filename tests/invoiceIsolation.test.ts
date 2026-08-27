// The rule that matters most in this whole area: a client sees their own money
// and nobody else's.
//
// This runs against a real Postgres - an in-process PGlite seeded from the same
// drizzle/schema-sync.sql every deploy applies - because the guarantee is in
// the WHERE clause, and a test with a stubbed database would be checking that
// my mock filters rather than that the query does.
//
// The doors a client-facing surface may use are invoiceForOrg and
// invoicesForOrg. Both take the org id off the share link's own row and apply
// it in the query. Point org 2's token at org 1's invoice id and the answer is
// null, decided in Postgres rather than by a redaction somewhere further up
// that a future page could forget to do.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });

vi.mock("@/db", () => ({ db: testDb }));

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (name, kind) VALUES ('Lab Zen', 'client'), ('Coastal Analytical', 'client');
    INSERT INTO invoices (org_id, number, status, issued_on, due_on) VALUES
      (1, 'INV-1001', 'sent', '2026-08-01', '2026-08-31'),
      (2, 'INV-1002', 'sent', '2026-07-01', '2026-07-31');
    INSERT INTO invoice_lines (invoice_id, kind, description, qty, unit_cents) VALUES
      (1, 'labor', 'Source rebuild', 9000, 18500),
      (2, 'part',  'HED supply',     1000, 39000);
    INSERT INTO payments (invoice_id, method, amount_cents, received_on) VALUES
      (1, 'check', 50000, '2026-08-10');
  `);
});

describe("a share token reaches only its own org's money", () => {
  it("returns the invoice when the org matches", async () => {
    const { invoiceForOrg } = await import("@/lib/invoiceData");
    const got = await invoiceForOrg(1, 1);
    expect(got?.row.number).toBe("INV-1001");
    expect(got?.lines).toHaveLength(1);
    expect(got?.payments).toHaveLength(1);
  });

  it("returns nothing when the org does not", async () => {
    const { invoiceForOrg } = await import("@/lib/invoiceData");
    expect(await invoiceForOrg(1, 2)).toBeNull();
    expect(await invoiceForOrg(2, 1)).toBeNull();
  });

  it("lists only that org's invoices", async () => {
    const { invoicesForOrg } = await import("@/lib/invoiceData");
    expect((await invoicesForOrg(1)).map((f) => f.row.number)).toEqual(["INV-1001"]);
    expect((await invoicesForOrg(2)).map((f) => f.row.number)).toEqual(["INV-1002"]);
  });

  it("sums what it fetched and nothing else", async () => {
    const { asStatementRow, invoicesForOrg } = await import("@/lib/invoiceData");
    const { statementFor } = await import("@/lib/statement");
    const s = statementFor({
      orgId: 1, today: "2026-08-22",
      invoices: (await invoicesForOrg(1)).map(asStatementRow),
    });
    // 9 h at $185 = $1,665, less the $500 that arrived.
    expect(s.openCents).toBe(116500);
    expect(s.open).toHaveLength(1);
  });
});

describe("the share viewer only ever calls the org-scoped doors", () => {
  it("never reaches invoiceById or allInvoices", () => {
    const src = readFileSync("src/app/share/[token]/page.tsx", "utf8");
    expect(src).toContain("invoiceForOrg");
    // The unscoped loaders exist for staff pages. On this file they would be a
    // client reading somebody else's ledger, so their absence is the test.
    expect(src).not.toContain("invoiceById");
    expect(src).not.toContain("allInvoices(");
  });
});

describe("no client-facing surface reaches a workspace-wide money reader", () => {
  /*
   * allInvoices(tenantOrgId) and invoicesForOrg(orgId) have the same shape and
   * the same return type, and exactly one of them is safe to render to a
   * client. Nothing in the type system tells them apart, so the separation is
   * which file calls which - and that is only enforced if somebody checks.
   *
   * These are the files that render to a client. The dashboard is on the list
   * because its client fork is the client's own landing page; the share and
   * drop viewers because they take a token and no session at all.
   */
  const CLIENT_FACING = [
    "src/app/share/[token]/page.tsx",
    "src/app/(dashboard)/page.tsx",
    "src/lib/clientView.ts",
  ];
  const WORKSPACE_WIDE = ["allInvoices(", "allQuotes(", "collectionsBoard(", "costingBoard(", "unbilledJobs("];

  for (const file of CLIENT_FACING) {
    it(`${file} calls no workspace-wide reader`, () => {
      const src = readFileSync(file, "utf8");
      for (const reader of WORKSPACE_WIDE) {
        expect(`${file}: ${src.includes(reader) ? reader : "clean"}`).toBe(`${file}: clean`);
      }
    });
  }
});
