// The three facts a service report names a machine by.
//
// A system carried a make, a model and a serial in its row from the day the
// table was written, and no screen in the app could set any of them - so the
// first report issued off a real job printed three blank lines where the
// client expects to read their instrument's nameplate. What is pinned here is
// that they save, that they audit like every other change to a record, and
// that clearing one is a thing somebody can mean.
//
// Real Postgres, in-process, from the same DDL every deploy applies.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });
vi.mock("@/db", () => ({ db: testDb }));

type Who = {
  email: string; name: string; role: string;
  orgId: number | null; operatorOrgId: number | null; rootOperatorOrgId: number | null;
};
let who: Who;
vi.mock("@/auth", () => ({ auth: async () => ({ user: who }) }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Map(),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const SIERRA = 1, UCSF = 2;
const SLOW = 30_000;

const OWNER: Who = {
  email: "joe@sierra.test", name: "Joe Harris", role: "owner",
  orgId: null, operatorOrgId: SIERRA, rootOperatorOrgId: SIERRA,
};

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator, parent_org_id) VALUES
      (${SIERRA}, 'Sierra Spectra', 'provider', true,  NULL),
      (${UCSF},   'UCSF',           'client',   false, ${SIERRA});
    INSERT INTO app_settings (id, operator_org_id) VALUES (1, ${SIERRA});
    INSERT INTO house_members (email, org_id, role, name) VALUES
      ('joe@sierra.test', ${SIERRA}, 'owner', 'Joe Harris');
  `);
});

beforeEach(async () => {
  who = OWNER;
  await client.exec(`
    DELETE FROM audit_log; DELETE FROM instruments;
    INSERT INTO instruments (id, tenant_org_id, external_id, client, category, model, owner_org_id) VALUES
      (1, ${SIERRA}, 'Q-ULT', 'UCSF', 'Quadrupole MS', '', ${UCSF});
  `);
});

describe("a system's nameplate", () => {
  it("saves the make, the model and the serial", async () => {
    const { updateInstrument } = await import("@/app/actions");
    const res = await updateInstrument(1, {
      manufacturer: " Thermo ", model: " Ultima ", serial: " 8339399 ",
    });
    expect(res.error).toBeUndefined();

    const [inst] = await testDb.select().from(schema.instruments);
    expect(inst.manufacturer).toBe("Thermo");
    expect(inst.model).toBe("Ultima");
    expect(inst.serial).toBe("8339399");
    // Everything else the form did not send stays as it was.
    expect(inst.externalId).toBe("Q-ULT");
    expect(inst.category).toBe("Quadrupole MS");
  }, SLOW);

  it("says so in the log, one line per fact", async () => {
    const { updateInstrument } = await import("@/app/actions");
    await updateInstrument(1, { manufacturer: "Thermo", serial: "8339399" });
    const rows = await testDb.select().from(schema.auditLog);
    expect(rows.map((r) => r.field).sort()).toEqual(["manufacturer", "serial"]);
    expect(rows.every((r) => r.entityType === "instrument" && r.entityId === "Q-ULT")).toBe(true);
  }, SLOW);

  it("lets a wrong serial be taken off again", async () => {
    const { updateInstrument } = await import("@/app/actions");
    await updateInstrument(1, { serial: "TYPO-1" });
    await updateInstrument(1, { serial: "" });
    const [inst] = await testDb.select().from(schema.instruments);
    expect(inst.serial).toBe("");
  }, SLOW);

  it("is what the report prints at the top", async () => {
    const { updateInstrument } = await import("@/app/actions");
    const { serviceReportDraft } = await import("@/lib/serviceReportData");
    await updateInstrument(1, { manufacturer: "Thermo", model: "Ultima", serial: "8339399" });
    await client.exec(`
      INSERT INTO work_orders (id, tenant_org_id, number, instrument_id, org_id, requested_by, title,
                               severity, state, assignee, opened_on, close_summary, resolved_at) VALUES
        (1, ${SIERRA}, '030305_W1', 1, ${UCSF}, 'Joe Harris', 'E2M18 High-Pitched Sound',
         'Down', 'resolved', 'Bill Harner', '2026-09-14', 'Examined the pump. All OK.', '2026-09-17T12:00:00Z');
    `);
    const draft = await serviceReportDraft(1);
    // No name on the system, so its category says what it is - and the make
    // is in front of it, the way the original writes the line.
    expect(draft?.report.instrument).toMatchObject({
      type: "Thermo Quadrupole MS", model: "Ultima", serial: "8339399",
    });
  }, SLOW);
});
