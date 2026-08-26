import { describe, expect, it, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import {
  TRAIL_KEEP_DAYS, TRAIL_KINDS, groupErrors, isTrailKind, maySeeTrail, routeShape,
  safeQuery, trailAdmins, trailSummary, type TrailRow,
} from "@/lib/trail";

/**
 * Where the errors are, as executable checks.
 *
 * The ask was "log pages and clicks - I'm trying to find where the errors
 * are", and the second half is the design. Clicks do not find errors: a click
 * record says a button was pressed, not that the thing behind it threw, and at
 * one row per press it buries the rows that answer the question.
 *
 * The other rule is that a debugging tool must never manufacture the failures
 * it exists to find, so every write path swallows its own.
 */

const row = (over: Partial<TrailRow> = {}): TrailRow => ({
  id: 1, kind: "error", email: "a@lab.test", role: "client_editor", orgName: "Lab Zen",
  viewingAs: "", route: "/instruments/4", query: "", message: "boom", detail: "at x",
  userAgent: "", at: new Date("2026-08-26T10:00:00Z"), ...over,
});

afterEach(() => { delete process.env.TRAIL_ADMINS; });

describe("who may read it", () => {
  it("is one named address, not a role", () => {
    /* Owners and platform staff are the usual keys in this app; neither is
       right here, because the contents are other companies' employees moving
       around their own portal. */
    expect(maySeeTrail("admin@ridgelinefield.com")).toBe(true);
    expect(maySeeTrail("owner@sierraspectra.test")).toBe(false);
    expect(maySeeTrail("")).toBe(false);
    expect(maySeeTrail(null)).toBe(false);
    expect(maySeeTrail(undefined)).toBe(false);
  });

  it("ignores case and stray spaces, the way a typed address arrives", () => {
    expect(maySeeTrail("  Admin@RidgelineField.com ")).toBe(true);
  });

  it("lets another instance name its own", () => {
    process.env.TRAIL_ADMINS = "ops@other.test, second@other.test";
    expect(trailAdmins()).toEqual(["ops@other.test", "second@other.test"]);
    expect(maySeeTrail("ops@other.test")).toBe(true);
    // Setting the list REPLACES the default rather than adding to it: an
    // instance that names its own admins has not asked for ours as well.
    expect(maySeeTrail("admin@ridgelinefield.com")).toBe(false);
  });
});

describe("what is kept, and what is not", () => {
  it("keeps a query's structure and loses what somebody typed", () => {
    /* "?stage=Refurbishment" explains a crash. "?q=Genentech" is a search a
       person typed, often a client's name, and it explains nothing. */
    expect(safeQuery("?stage=Refurbishment&q=genentech"))
      .toBe("stage=Refurbishment&q=…");
    expect(safeQuery("?where=Hayward&search=maria+chen"))
      .toBe("where=Hayward&search=…");
    expect(safeQuery("")).toBe("");
    expect(safeQuery("?f")).toBe("f");
  });

  it("strips every param that carries a person's words", () => {
    for (const k of ["q", "search", "email", "name", "token", "note", "reason"]) {
      expect(safeQuery(`?${k}=something`), k).toBe(`${k}=…`);
    }
  });

  it("generalises ids so one broken page is one row", () => {
    // A hundred rows for a hundred instruments hides that they are one bug.
    expect(routeShape("/instruments/412")).toBe("/instruments/:id");
    expect(routeShape("/orders/i/98")).toBe("/orders/i/:id");
    expect(routeShape("/listing/abcdefghijklmnopqrstuvwxyz")).toBe("/listing/:token");
    // Words that merely look long are left alone.
    expect(routeShape("/money/reimbursements")).toBe("/money/reimbursements");
    expect(routeShape("/")).toBe("/");
  });

  it("has an end. A log with no end is a different product", () => {
    expect(TRAIL_KEEP_DAYS).toBeGreaterThan(7);
    expect(TRAIL_KEEP_DAYS).toBeLessThanOrEqual(90);
  });

  it("knows only two kinds, and clicks are not one of them", () => {
    expect(TRAIL_KINDS).toEqual(["page", "error"]);
    expect(isTrailKind("click")).toBe(false);
    expect(isTrailKind("page")).toBe(true);
  });
});

describe("errors, grouped the way somebody would fix them", () => {
  it("counts one bug once however many times it was hit", () => {
    const g = groupErrors([
      row({ id: 1, route: "/instruments/4" }),
      row({ id: 2, route: "/instruments/9", email: "b@lab.test" }),
      row({ id: 3, route: "/instruments/12" }),
    ]);
    expect(g).toHaveLength(1);
    expect(g[0].count).toBe(3);
    expect(g[0].route).toBe("/instruments/:id");
    // Who it is happening to, which is how you tell one person's broken
    // browser from a page that is broken for everyone.
    expect(g[0].people).toEqual(["a@lab.test", "b@lab.test"]);
  });

  it("keeps different messages on the same page apart", () => {
    const g = groupErrors([row({ id: 1 }), row({ id: 2, message: "different" })]);
    expect(g).toHaveLength(2);
  });

  it("puts what is hitting the most people the most often first", () => {
    const g = groupErrors([
      row({ id: 1, message: "rare" }),
      row({ id: 2, message: "common" }),
      row({ id: 3, message: "common" }),
    ]);
    expect(g[0].message).toBe("common");
  });

  it("keeps the fullest stack of the group, not the first", () => {
    const g = groupErrors([
      row({ id: 1, detail: "short" }),
      row({ id: 2, detail: "a much longer stack with the actual frames in it" }),
    ]);
    expect(g[0].detail).toMatch(/actual frames/);
  });

  it("ignores page rows entirely", () => {
    expect(groupErrors([row({ kind: "page", message: "" })])).toEqual([]);
  });

  it("summarises a window without double-counting a person", () => {
    const s = trailSummary([
      row({ id: 1, kind: "page" }), row({ id: 2, kind: "page" }), row({ id: 3, kind: "error" }),
    ]);
    expect(s).toEqual({ people: 1, pages: 2, errors: 1 });
  });
});

describe("it cannot break the thing it is watching", () => {
  const read = (f: string) => readFileSync(f, "utf8");

  it("swallows every failure on the write path", () => {
    /* A debugging tool that can fail a page would manufacture the very errors
       it exists to find, on the pages people actually use. */
    const src = read("src/lib/trailData.ts");
    for (const fn of ["recordTrail", "trailSince", "trailAround", "pruneTrail", "trailCount"]) {
      const body = src.slice(src.indexOf(`export async function ${fn}`));
      expect(body.slice(0, body.indexOf("\n}\n")), fn).toMatch(/catch/);
    }
  });

  it("checks the toggle in ONE place, on the write itself", () => {
    // A second copy of "is this on" is a path that records while the switch
    // says off.
    const src = read("src/lib/trailData.ts");
    expect(src).toMatch(/if \(!\(await trailOn\(\)\)\) return;/);
  });

  it("records the real person, never the persona", () => {
    /* The banner over view-as promises "anything you change is still recorded
       as you". A trail that recorded the persona would break that promise in
       the one place somebody goes to find out who did something. */
    const src = read("src/app/actions.ts");
    const fn = src.slice(src.indexOf("export async function reportTrail"));
    expect(fn.slice(0, 1400)).toMatch(/email: real\.email/);
    expect(fn.slice(0, 1400)).toMatch(/viewingAs: persona \? persona\.orgName : ""/);
  });

  it("takes who from the session, never from the browser's payload", () => {
    const src = read("src/app/actions.ts");
    const fn = src.slice(src.indexOf("export async function reportTrail"), src.indexOf("export async function clearTrail"));
    // The input type carries no identity at all.
    expect(fn).toMatch(/kind: string; route: string; search\?: string; message\?: string; detail\?: string;/);
    expect(fn).not.toMatch(/input\.email/);
  });

  it("only whoever may read it may clear it", () => {
    const src = read("src/app/actions.ts");
    const fn = src.slice(src.indexOf("export async function clearTrail"));
    expect(fn.slice(0, 400)).toMatch(/maySeeTrail\(u\.email\)/);
  });

  it("catches the render errors window.onerror never sees", () => {
    // A React render error is swallowed by the boundary, so before this the
    // most common failure in a Next app was the one kind nothing recorded.
    const src = read("src/app/error.tsx");
    expect(src).toMatch(/reportTrail\(/);
    expect(src).toMatch(/kind: "error"/);
    expect(src).toMatch(/error\.digest/);
  });

  it("mounts nothing at all when the module is off", () => {
    const src = read("src/app/layout.tsx");
    expect(src).toMatch(/modules\.trail && user && \(/);
  });

  it("is off on a fresh install", () => {
    const schema = read("src/db/schema.ts");
    expect(schema).toMatch(/trailEnabled: boolean\("trail_enabled"\)\.notNull\(\)\.default\(false\)/);
  });

  it("hides the door from everyone who cannot open it", () => {
    const nav = read("src/lib/settingsNav.ts");
    expect(nav).toMatch(/trailAdminOnly: true/);
    expect(nav).toMatch(/isTrailAdmin \|\| !e\.trailAdminOnly/);
  });
});
