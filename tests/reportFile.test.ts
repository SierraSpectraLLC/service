// Filing and driving a report, through the real actions.
//
// Three things a pure test cannot reach. What gets CAPTURED without anybody
// typing it, since that is what makes a report actionable. Who may read whose,
// which is the routing that decides whether a bug in the software ever reaches
// somebody who can fix it. And that the breadcrumbs attached are the
// reporter's own and nobody else's - the trail is gated to one address for
// good reason, and this is the one crack in it.
import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { PGlite } = await import("@electric-sql/pglite");
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("@/db/schema");

const client = new PGlite();
const testDb = drizzle(client, { schema });

type Who = {
  email: string; name: string; role: string;
  orgId: number | null; operatorOrgId: number | null; rootOperatorOrgId: number | null;
} | null;
let who: Who = null;
/** Who the notification actually went to. */
let sent: string[] = [];

vi.mock("@/db", () => ({ db: testDb }));
vi.mock("@/auth", () => ({ auth: async () => (who ? { user: who } : null) }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
  headers: async () => new Map([["user-agent", "Mozilla/5.0 Chrome/120.0 Safari/537.36"]]),
}));

/** 3 = Sierra Spectra (root), 5 = Cascade, a second operator. */
const JOE: Who = {
  email: "joe@sierra.test", name: "Joe", role: "owner",
  orgId: null, operatorOrgId: 3, rootOperatorOrgId: 3,
};
const BILL: Who = {
  email: "bill@sierra.test", name: "Bill Reyes", role: "staff",
  orgId: null, operatorOrgId: 3, rootOperatorOrgId: 3,
};
const CASS: Who = {
  email: "cass@cascade.test", name: "Cass", role: "owner",
  orgId: null, operatorOrgId: 5, rootOperatorOrgId: 3,
};
const MARIA: Who = {
  email: "maria@labzen.test", name: "Maria", role: "client_editor",
  orgId: 1, operatorOrgId: null, rootOperatorOrgId: null,
};

beforeAll(async () => {
  const notify = await import("@/lib/notify");
  vi.spyOn(notify, "notifyBugReport").mockImplementation(async (o) => { sent = o.to; });
  await client.exec(readFileSync("drizzle/schema-sync.sql", "utf8"));
  await client.exec(`
    INSERT INTO orgs (id, name, kind, is_operator) VALUES
      (1, 'Lab Zen', 'client', false),
      (3, 'Sierra Spectra', 'provider', true),
      (5, 'Cascade Analytical', 'provider', true);
    SELECT setval('orgs_id_seq', 100);
    INSERT INTO house_members (email, org_id, role, name) VALUES
      ('joe@sierra.test', 3, 'owner', 'Joe'),
      ('bill@sierra.test', 3, 'staff', 'Bill Reyes'),
      ('cass@cascade.test', 5, 'owner', 'Cass');
  `);
});

beforeEach(async () => {
  who = null; sent = [];
  await client.exec(`DELETE FROM bug_reports; DELETE FROM trail_events;`);
});

const FILE = {
  kind: "bug", title: "The invoice total is $200 short", body: "Covered lines look double-counted",
  blocking: true, route: "/money/invoices/12", search: "?tab=lines&q=Genentech",
  viewport: "1400x900",
};
const rows = () => testDb.select().from(schema.bugReports);

describe("what gets captured without anybody typing it", () => {
  it("keeps where they were, on which build, in which browser", async () => {
    who = BILL;
    const { fileReport } = await import("@/app/actions");
    expect((await fileReport(FILE)).error).toBeUndefined();

    const [r] = await rows();
    expect(r.title).toBe("The invoice total is $200 short");
    expect(r.route).toBe("/money/invoices/12");
    expect(r.viewport).toBe("1400x900");
    expect(r.userAgent).toContain("Chrome");
    expect(r.blocking).toBe(true);
    expect(r.status).toBe("new");
    expect(r.reportedBy).toBe("bill@sierra.test");
    expect(r.reportedByName).toBe("Bill Reyes");
    expect(r.tenantOrgId).toBe(3);
  });

  it("scrubs the search box out of the query it keeps", async () => {
    /*
     * "?q=Genentech" is a client's name somebody typed, and it has no bearing
     * on why a page broke. Same rule the trail runs on - the KEY survives, so
     * the report can still say they were searching.
     */
    who = BILL;
    const { fileReport } = await import("@/app/actions");
    await fileReport(FILE);
    const [r] = await rows();
    expect(r.query).toContain("tab=lines");
    expect(r.query).not.toContain("Genentech");
  });

  it("refuses one nobody could act on", async () => {
    who = BILL;
    const { fileReport } = await import("@/app/actions");
    expect((await fileReport({ ...FILE, title: "bad" })).error).toContain("in a line");
    expect((await fileReport({ ...FILE, kind: "rant" })).error).toContain("what kind");
    expect(await rows()).toHaveLength(0);
  });

  it("is staff only - a client has Request service for their instruments", async () => {
    who = MARIA;
    const { fileReport } = await import("@/app/actions");
    await expect(fileReport(FILE)).rejects.toThrow();
    expect(await rows()).toHaveLength(0);
  });
});

describe("the breadcrumbs", () => {
  const trail = async (email: string, route: string, kind = "page", minsAgo = 1) => {
    await testDb.insert(schema.trailEvents).values({
      kind, email, route, message: kind === "error" ? "Cannot read length of null" : "",
      at: new Date(Date.now() - minsAgo * 60_000),
    });
  };

  it("attaches the reporter's own last few minutes", async () => {
    await trail("bill@sierra.test", "/work", "page", 3);
    await trail("bill@sierra.test", "/money/invoices/12", "error", 1);
    who = BILL;
    const { fileReport } = await import("@/app/actions");
    await fileReport(FILE);

    const { parseCrumbs } = await import("@/lib/bugs");
    const crumbs = parseCrumbs((await rows())[0].breadcrumbs);
    expect(crumbs).toHaveLength(2);
    // Newest first: the error they just hit leads.
    expect(crumbs[0].kind).toBe("error");
    expect(crumbs[0].message).toContain("Cannot read");
    expect(crumbs.map((c) => c.route)).toContain("/work");
  });

  it("never attaches a colleague's afternoon", async () => {
    /*
     * The trail is readable by one address on the whole instance, because it
     * is a record of where people spend their day. This is the one crack in
     * that, and it is narrow by construction: the reporter's own rows only.
     */
    await trail("joe@sierra.test", "/money/payroll", "page", 2);
    await trail("bill@sierra.test", "/work", "page", 2);
    who = BILL;
    const { fileReport } = await import("@/app/actions");
    await fileReport(FILE);

    const { parseCrumbs } = await import("@/lib/bugs");
    const crumbs = parseCrumbs((await rows())[0].breadcrumbs);
    expect(crumbs.map((c) => c.route)).toEqual(["/work"]);
  });

  it("leaves out anything older than the window", async () => {
    // An hour ago is not context, it is yesterday's work.
    await trail("bill@sierra.test", "/ancient", "page", 24 * 60);
    who = BILL;
    const { fileReport } = await import("@/app/actions");
    await fileReport(FILE);
    const { parseCrumbs } = await import("@/lib/bugs");
    expect(parseCrumbs((await rows())[0].breadcrumbs)).toEqual([]);
  });
});

describe("who hears about it", () => {
  it("tells the workspace's owner and the platform, once each", async () => {
    // The owner triages their shop's list; the platform fixes the software.
    // A report that only reached the first would sit there being true.
    who = BILL;
    const { fileReport } = await import("@/app/actions");
    await fileReport(FILE);
    expect(sent).toContain("joe@sierra.test");
    expect(sent).toContain("admin@ridgelinefield.com");
    expect(sent).not.toContain("cass@cascade.test");
    expect(new Set(sent).size).toBe(sent.length);
  });
});

describe("who reads whose", () => {
  const file = async (as: Who, title: string) => {
    who = as;
    const { fileReport } = await import("@/app/actions");
    await fileReport({ ...FILE, title });
  };

  it("shows a workspace its own, and only its own", async () => {
    await file(BILL, "Sierra saw something wrong");
    await file(CASS, "Cascade saw something wrong");
    const { reportsFor } = await import("@/lib/bugData");

    const sierra = await reportsFor(3, false);
    expect(sierra.map((r) => r.title)).toEqual(["Sierra saw something wrong"]);
    const cascade = await reportsFor(5, false);
    expect(cascade.map((r) => r.title)).toEqual(["Cascade saw something wrong"]);
  });

  it("shows platform staff every workspace's, named", async () => {
    /*
     * The routing that makes this worth building. A bug in the SOFTWARE is
     * not an operator's to fix, so the reports have to reach whoever ships
     * it - otherwise every shop keeps a private list of the same bug.
     */
    await file(BILL, "Sierra saw something wrong");
    await file(CASS, "Cascade saw something wrong");
    const { reportsFor } = await import("@/lib/bugData");
    const all = await reportsFor(3, true);
    expect(all).toHaveLength(2);
    expect(all.map((r) => r.fromName).sort()).toEqual(["Cascade Analytical", "Sierra Spectra"]);
  });

  it("shows nothing to a reader with no workspace and no platform seat", async () => {
    await file(BILL, "Sierra saw something wrong");
    const { reportsFor } = await import("@/lib/bugData");
    expect(await reportsFor(null, false)).toEqual([]);
  });
});

describe("driving one to an end", () => {
  const one = async () => {
    who = BILL;
    const { fileReport } = await import("@/app/actions");
    await fileReport(FILE);
    return (await rows())[0];
  };

  it("picks up without a word, and ends only with one", async () => {
    const r = await one();
    const { setReportStatus } = await import("@/app/actions");
    who = JOE;
    expect(await setReportStatus(r.id, "open")).toEqual({});
    expect((await setReportStatus(r.id, "fixed", "  ")).error).toContain("what was fixed");
    expect((await setReportStatus(r.id, "closed", "")).error).toContain("why it is closed");

    expect(await setReportStatus(r.id, "fixed", "Covered lines were double-counted")).toEqual({});
    const [after] = await rows();
    expect(after.status).toBe("fixed");
    expect(after.resolution).toContain("double-counted");
    expect(after.resolvedBy).toBe("joe@sierra.test");
    expect(after.resolvedAt).not.toBeNull();
  });

  it("clears the resolution when it is reopened", async () => {
    // A reopened report carrying last week's "fixed" note reads as fixed to
    // everybody who glances at it.
    const r = await one();
    const { setReportStatus } = await import("@/app/actions");
    who = JOE;
    await setReportStatus(r.id, "fixed", "thought this was done");
    await setReportStatus(r.id, "open");
    const [after] = await rows();
    expect(after.resolution).toBe("");
    expect(after.resolvedAt).toBeNull();
  });

  it("refuses another workspace's report, and any status that is not one", async () => {
    const r = await one();
    const { setReportStatus } = await import("@/app/actions");
    who = CASS;
    expect((await setReportStatus(r.id, "open")).error).toBe("Not found");
    who = JOE;
    expect((await setReportStatus(r.id, "wontfix", "no")).error).toBe("Not a status");
    expect((await rows())[0].status).toBe("new");
  });

  it("lets the staff member who filed it drive their own shop's list", async () => {
    // Not owner-only: whoever filed one is the person who most needs to see
    // it move, and a queue only the owner can touch is a queue nobody files
    // into twice.
    const r = await one();
    who = BILL;
    const { setReportStatus } = await import("@/app/actions");
    expect(await setReportStatus(r.id, "open")).toEqual({});
  });
});
