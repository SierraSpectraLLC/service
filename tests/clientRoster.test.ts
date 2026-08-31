// The client roster: who the shop works for, and what of theirs it looks after.
//
// The room this feeds exists because the only list of clients in the app was
// inside owner-only Settings, so an engineer could work a client's system all
// week without being able to look the company up. What is pinned here is the
// shaping and the searching - the counting rules that decide what a row says.
import { describe, expect, it } from "vitest";
import { clientRoster, filterRoster, rosterSummary, type RosterOrg } from "@/lib/clientRoster";

const org = (id: number, name: string, kind = "client", prospect = false): RosterOrg =>
  ({ id, name, kind, themeColor: "", prospect });

const ORGS = [org(1, "Lab Zen"), org(2, "Testen"), org(3, "Cascade Instrument", "provider")];

describe("counting what we look after", () => {
  it("tallies systems, sites and open work per company", () => {
    const rows = clientRoster(
      ORGS,
      [{ ownerOrgId: 1 }, { ownerOrgId: 1 }, { ownerOrgId: 2 }],
      [{ orgId: 1 }],
      [{ orgId: 2 }, { orgId: 2 }, { orgId: 2 }],
    );
    expect(rows.find((r) => r.id === 1)).toMatchObject({ systems: 2, sites: 1, openWork: 0 });
    expect(rows.find((r) => r.id === 2)).toMatchObject({ systems: 1, sites: 0, openWork: 3 });
  });

  it("gives a company with nothing of ours a row of zeros, not no row", () => {
    // A client the shop has just taken on has nothing counted yet, and is
    // exactly the company somebody is looking up.
    const rows = clientRoster(ORGS, [], [], []);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.systems === 0 && r.sites === 0 && r.openWork === 0)).toBe(true);
  });

  it("ignores rows that belong to nobody", () => {
    /*
     * A work order filed against no company, and a system with no owner set,
     * are both real rows. Counting them under some organization would be
     * inventing a fact; they simply belong to none of these lines.
     */
    const rows = clientRoster(ORGS, [{ ownerOrgId: null }], [], [{ orgId: null }]);
    expect(rows.every((r) => r.systems === 0 && r.openWork === 0)).toBe(true);
  });

  it("counts nothing for a company that is not on the list", () => {
    // The counts are scoped by the caller's query; an id outside the roster is
    // another workspace's and must not create a row here.
    const rows = clientRoster([org(1, "Lab Zen")], [{ ownerOrgId: 99 }], [], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].systems).toBe(0);
  });
});

describe("the summary on the row", () => {
  it("says only what there is", () => {
    expect(rosterSummary({ systems: 2, sites: 1, openWork: 0 })).toBe("2 systems · 1 site");
    expect(rosterSummary({ systems: 1, sites: 0, openWork: 3 })).toBe("1 system · 3 open");
  });

  it("says nothing rather than three zeros", () => {
    // "0 systems · 0 sites · 0 open" is three numbers to read to learn that the
    // answer is nothing.
    expect(rosterSummary({ systems: 0, sites: 0, openWork: 0 })).toBe("nothing of ours yet");
  });
});

describe("filtering the list", () => {
  const rows = clientRoster(ORGS, [], [], []);

  it("matches a name however it was typed", () => {
    expect(filterRoster(rows, { q: "lab" }).map((r) => r.name)).toEqual(["Lab Zen"]);
    expect(filterRoster(rows, { q: "  ZEN " }).map((r) => r.name)).toEqual(["Lab Zen"]);
  });

  it("narrows to one kind", () => {
    expect(filterRoster(rows, { kind: "provider" }).map((r) => r.name)).toEqual(["Cascade Instrument"]);
    expect(filterRoster(rows, { kind: "client" })).toHaveLength(2);
  });

  it("treats no facet as every kind, not as none", () => {
    // The bug every filtered list gets exactly once.
    expect(filterRoster(rows, {})).toHaveLength(3);
    expect(filterRoster(rows, { kind: "", q: "" })).toHaveLength(3);
  });

  it("applies both at once", () => {
    expect(filterRoster(rows, { kind: "client", q: "cascade" })).toEqual([]);
  });
});
