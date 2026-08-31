// The client roster's queries, against a real database.
//
// lib/clientRoster pins the shaping; this pins the READING - which companies
// the page puts in front of a staff member, and which it must not. The
// interesting ones are the exclusions, because every one of them is a way the
// list could quietly be wrong rather than empty:
//
//   * the shop itself is not one of its own clients, and visibleOrgs hands it
//     over along with them;
//   * another service company's clients are not this one's, however the tenant
//     predicate is written;
//   * the counts are scoped the same way the list is - a system belonging to
//     the company next door must not swell a row here.
//
// Real Postgres, in-process, from the same DDL every deploy applies.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

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

const ROOT = 1, SIERRA = 2, LABZEN = 3, TESTEN = 4, CASCADE = 5, THEIRS = 6;

const TECH: Who = {
  email: "tech@sierra.test", name: "Steve Jones", role: "staff",
  orgId: null, operatorOrgId: SIERRA, rootOperatorOrgId: ROOT,
};

beforeAll(async () => {
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator, parent_org_id) VALUES
      (${ROOT},    'Ridgeline',          'provider', true,  NULL),
      (${SIERRA},  'Sierra Spectra',     'provider', true,  NULL),
      (${LABZEN},  'Lab Zen',            'client',   false, ${SIERRA}),
      (${TESTEN},  'Testen',             'client',   false, ${SIERRA}),
      -- A provider inside Sierra's workspace: a subcontractor, not a tenant.
      (${CASCADE}, 'Cascade Calibration','provider', false, ${SIERRA}),
      -- Another service company's client. Never Sierra's business.
      (${THEIRS},  'Someone Else Labs',  'client',   false, ${ROOT});
    INSERT INTO app_settings (id, operator_org_id) VALUES (1, ${ROOT});

    INSERT INTO house_members (email, org_id, role, name) VALUES
      ('tech@sierra.test', ${SIERRA}, 'staff', 'Steve Jones');

    INSERT INTO instruments (id, tenant_org_id, owner_org_id, external_id, client, model) VALUES
      (1, ${SIERRA}, ${LABZEN}, 'LZ-1', 'Lab Zen', 'LC-MS'),
      (2, ${SIERRA}, ${LABZEN}, 'LZ-2', 'Lab Zen', 'GC-MS'),
      (3, ${SIERRA}, ${TESTEN}, 'TS-1', 'Testen',  'ICP-MS'),
      -- The company next door's system, on their own workspace's stamp.
      (4, ${ROOT},   ${THEIRS}, 'XX-1', 'Someone', 'NMR'),
      /* A row stamped to ANOTHER workspace while naming one of ours as owner.
         It should not exist, and that is the point: it is what the tenant
         predicate on the count query defends against, and without that
         predicate it would quietly inflate Lab Zen's fleet by one. */
      (5, ${ROOT},   ${LABZEN}, 'XX-2', 'Lab Zen', 'TOC');

    INSERT INTO org_sites (id, tenant_org_id, org_id, name, address) VALUES
      (1, ${SIERRA}, ${LABZEN}, 'Pier Road', '1 Pier Rd'),
      (2, ${SIERRA}, ${LABZEN}, 'Annex',     '2 Pier Rd');

    INSERT INTO work_orders (id, tenant_org_id, org_id, number, title, state) VALUES
      (1, ${SIERRA}, ${LABZEN}, 'WO-1', 'Commissioning', 'active'),
      (2, ${SIERRA}, ${LABZEN}, 'WO-2', 'PM',            'open'),
      -- Settled: put away, and must not keep counting forever.
      (3, ${SIERRA}, ${LABZEN}, 'WO-3', 'Old job',       'closed'),
      (4, ${SIERRA}, ${LABZEN}, 'WO-4', 'Dropped',       'cancelled'),
      -- Filed against no company at all - a real row that belongs to nobody.
      (5, ${SIERRA}, NULL,      'WO-5', 'Bench work',    'open');
  `);
});

/** The page's own reading, run as this person. */
const roster = async (params: { q?: string; kind?: string } = {}) => {
  const page = (await import("@/app/clients/page")).default;
  // The page is a server component; rendering it needs React, so the assertions
  // below go through the element tree it returns.
  const el = await page({ searchParams: Promise.resolve(params) });
  // The panel is handed the finished rows - that is the value under test.
  const find = (node: unknown): { rows?: unknown[] } | null => {
    const n = node as { props?: Record<string, unknown>; type?: unknown };
    if (!n || typeof n !== "object") return null;
    if (n.props && Array.isArray((n.props as { rows?: unknown[] }).rows)) {
      return n.props as { rows: unknown[] };
    }
    const kids = (n.props?.children ?? []) as unknown;
    for (const k of Array.isArray(kids) ? kids : [kids]) {
      const hit = find(k);
      if (hit) return hit;
    }
    return null;
  };
  const panel = find(el);
  return (panel?.rows ?? []) as { id: number; name: string; kind: string;
    systems: number; sites: number; openWork: number }[];
};

describe("who a staff member sees", () => {
  it("lists the workspace's companies, counted", async () => {
    who = TECH;
    const rows = await roster();
    const lz = rows.find((r) => r.name === "Lab Zen")!;
    expect(lz.systems).toBe(2);
    expect(lz.sites).toBe(2);
    // Two still going; the closed and the cancelled one are put away, and the
    // bench job belongs to nobody.
    expect(lz.openWork).toBe(2);
    expect(rows.find((r) => r.name === "Testen")).toMatchObject({ systems: 1, sites: 0, openWork: 0 });
  });

  it("does not list the shop among its own clients", async () => {
    // visibleOrgs hands Sierra over with the rest - tenantOf resolves an
    // operator to itself - and a shop on its own client list reads as a bug.
    who = TECH;
    expect((await roster()).map((r) => r.name)).not.toContain("Sierra Spectra");
  });

  it("never shows another service company's client", async () => {
    who = TECH;
    const names = (await roster()).map((r) => r.name);
    expect(names).not.toContain("Someone Else Labs");
    expect(names).not.toContain("Ridgeline");
  });

  it("counts only what is stamped to this workspace", async () => {
    /*
     * The counts carry the same tenant predicate the list does, and this is
     * the row that proves it rather than merely implying it: a system stamped
     * to another workspace that names one of OUR clients as its owner. Scoped
     * by owner id alone it would land on Lab Zen's row.
     */
    who = TECH;
    const rows = await roster();
    expect(rows.find((r) => r.name === "Lab Zen")!.systems).toBe(2);
    expect(rows.reduce((n, r) => n + r.systems, 0)).toBe(3);
  });

  it("includes a provider inside the workspace, alongside the clients", async () => {
    who = TECH;
    const rows = await roster();
    expect(rows.find((r) => r.name === "Cascade Calibration")?.kind).toBe("provider");
  });

  it("narrows by the facet and the search box", async () => {
    who = TECH;
    expect((await roster({ kind: "provider" })).map((r) => r.name)).toEqual(["Cascade Calibration"]);
    expect((await roster({ q: "zen" })).map((r) => r.name)).toEqual(["Lab Zen"]);
  });

  it("sorts by name, so the list is where it was last time", async () => {
    who = TECH;
    const names = (await roster()).map((r) => r.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});
