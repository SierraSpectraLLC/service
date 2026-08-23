// The hold, computed from real rows in a real Postgres.
//
// tests/credit.ts proves the rule and tests/creditEnforcement.ts proves the
// rule is wired into the actions that commit a drive. This one proves the
// piece between them: that reading a client's actual invoices produces the
// standing the rule is handed, and that recording a payment or writing an
// override changes it. That is the whole path a dispatcher depends on.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });
vi.mock("@/db", () => ({ db: testDb }));

const TODAY = "2026-08-23";

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO app_settings (id) VALUES (1);
    INSERT INTO orgs (name, kind) VALUES ('Lab Zen', 'client'), ('Coastal Analytical', 'client');
    -- Coastal holds at 20 days or $500; Lab Zen keeps the platform defaults.
    UPDATE orgs SET billing_policy =
      '{"holdDays":20,"holdAmountCents":50000}'::jsonb WHERE id = 2;
    INSERT INTO invoices (org_id, number, status, issued_on, due_on) VALUES
      (1, 'INV-1001', 'sent', '2026-08-01', '2026-08-31'),
      (2, 'INV-1002', 'sent', '2026-06-12', '2026-07-12');
    INSERT INTO invoice_lines (invoice_id, kind, description, qty, unit_cents) VALUES
      (1, 'labor', 'Source rebuild', 1000, 45000),
      (2, 'part',  'HED supply',     1000, 429000);
  `);
});

const standing = async (orgId: number) =>
  (await import("@/lib/invoiceData")).creditFor(orgId, TODAY);

describe("credit standing, read from the ledger", () => {
  it("holds the client whose invoice is 42 days past due", async () => {
    const s = await standing(2);
    expect(s.onHold).toBe(true);
    expect(s.kind).toBe("both");
    expect(s.oldestDaysLate).toBe(42);
    expect(s.balanceCents).toBe(429000);
    expect(s.line).toContain("42 days past due (policy holds at 20)");
  });

  it("leaves alone the client who is inside terms", async () => {
    const s = await standing(1);
    expect(s.onHold).toBe(false);
    expect(s.balanceCents).toBe(45000);
  });

  it("refuses both drive-committing moves for the held one and neither for the other", async () => {
    const { holdRefusal } = await import("@/lib/credit");
    const held = await standing(2);
    const clear = await standing(1);
    expect(holdRefusal(held, "dispatch", "Coastal")).toContain("Cannot assign somebody to");
    expect(holdRefusal(held, "start", "Coastal")).toContain("Cannot start this job");
    expect(holdRefusal(clear, "dispatch")).toBe("");
    expect(holdRefusal(clear, "start")).toBe("");
  });
});

describe("what changes the answer", () => {
  it("an owner's override lifts it, and the reason rides along", async () => {
    await client.exec(`
      INSERT INTO credit_overrides (org_id, reason, granted_by)
      VALUES (2, 'Controller confirmed the wire goes Friday', 'joe@shop.test');
    `);
    const { holdRefusal } = await import("@/lib/credit");
    const s = await standing(2);
    expect(s.onHold).toBe(false);
    expect(s.override?.reason).toBe("Controller confirmed the wire goes Friday");
    expect(s.line).toContain("Would be on hold");
    // The point of demanding a reason: the work actually goes through.
    expect(holdRefusal(s, "dispatch", "Coastal")).toBe("");
  });

  it("lifting the override puts the hold back", async () => {
    await client.exec(`UPDATE credit_overrides SET lifted_at = now() WHERE org_id = 2;`);
    const s = await standing(2);
    expect(s.onHold).toBe(true);
  });

  it("paying the balance clears it with no flag to un-set", async () => {
    // Nothing stores "on hold". Paying makes the sum smaller and the answer
    // changes by arithmetic the next time anybody looks.
    await client.exec(`
      INSERT INTO payments (invoice_id, method, amount_cents, received_on)
      VALUES (2, 'ach', 429000, '2026-08-23');
    `);
    const s = await standing(2);
    expect(s.balanceCents).toBe(0);
    expect(s.onHold).toBe(false);
    const { holdRefusal } = await import("@/lib/credit");
    expect(holdRefusal(s, "start", "Coastal")).toBe("");
  });
});
