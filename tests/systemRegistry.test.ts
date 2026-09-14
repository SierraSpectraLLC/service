import { describe, expect, it } from "vitest";
import { SYSTEM_STATES, filterSystems, systemOwnerName, systemState } from "@/lib/systemRegistry";

/**
 * The systems registry is the record, not the fleet: every system on the
 * books, one row each, with a prospect's and a former client's machines
 * present and marked rather than held back. These pin what a row is and
 * which rows a reading keeps.
 */
const row = (over: Partial<Parameters<typeof filterSystems>[0][number]> = {}) => ({
  externalId: "SS-1042", label: "Agilent 6470", client: "Lab Zen", owner: "Lab Zen", model: "6470", serial: "SG1234",
  location: "Bldg 2", lead: "Bill", category: "LC-MS", state: "active" as const, ...over,
});

describe("systemState", () => {
  it("is archived first, whoever owns it", () => {
    expect(systemState({ archived: true }, "client")).toBe("archived");
    expect(systemState({ archived: true }, "prospect")).toBe("archived");
  });
  it("otherwise follows the owner's stage, and the shop's own are in the fleet", () => {
    expect(systemState({ archived: false }, "client")).toBe("active");
    expect(systemState({ archived: false }, "prospect")).toBe("prospect");
    expect(systemState({ archived: false }, "former")).toBe("former");
    // An unknown or unset stage is a client to stageOf, which keeps the
    // machine on the list - the safe direction.
    expect(systemState({ archived: false }, undefined)).toBe("active");
    expect(systemState({ archived: false }, "")).toBe("active");
  });
  it("has a facet for every state it can answer", () => {
    expect(SYSTEM_STATES.map((s) => s.key).sort()).toEqual(["active", "archived", "former", "prospect"]);
  });
});

describe("systemOwnerName", () => {
  const orgs = [{ id: 7, name: "LabZen" }, { id: 9, name: "GMI" }];
  it("is the owning organization's name, whatever the label says", () => {
    // The bug: ACQ-004 owned by LabZen with a blank label headed a "(no
    // client)" group while its own page said LabZen.
    expect(systemOwnerName({ client: "", ownerOrgId: 7 }, orgs)).toBe("LabZen");
    expect(systemOwnerName({ client: "Lab Zen", ownerOrgId: 7 }, orgs)).toBe("LabZen");
  });
  it("falls back to the client text when nobody on the platform owns it", () => {
    expect(systemOwnerName({ client: " Casablanca ", ownerOrgId: null }, orgs)).toBe("Casablanca");
    // A link to an organization the viewer cannot see names nothing better.
    expect(systemOwnerName({ client: "Utah", ownerOrgId: 99 }, orgs)).toBe("Utah");
  });
  it("is blank, not a made-up word, when there is neither", () => {
    expect(systemOwnerName({ client: "", ownerOrgId: null }, orgs)).toBe("");
  });
});

describe("filterSystems", () => {
  const rows = [
    row({ externalId: "SS-1" }),
    row({ externalId: "SS-2", state: "prospect", client: "Acme", owner: "Acme" }),
    row({ externalId: "SS-3", state: "former" }),
    row({ externalId: "SS-4", state: "archived" }),
    // Owner and client are two facts: a refurb we own that is destined for a
    // client. The search finds it by either name.
    row({ externalId: "SS-5", client: "Utah", owner: "Sierra Spectra" }),
  ];
  it("shows everything on record but the archive and a former client's when no state is named", () => {
    // A prospect's stays, marked - it is being quoted this week. A former
    // client's is held back like the archive: on record, its own facet away.
    expect(filterSystems(rows, {}).map((r) => r.externalId)).toEqual(["SS-1", "SS-2", "SS-5"]);
  });
  it("narrows to one state, the archive included, when one is named", () => {
    expect(filterSystems(rows, { state: "archived" }).map((r) => r.externalId)).toEqual(["SS-4"]);
    expect(filterSystems(rows, { state: "prospect" }).map((r) => r.externalId)).toEqual(["SS-2"]);
    expect(filterSystems(rows, { state: "former" }).map((r) => r.externalId)).toEqual(["SS-3"]);
  });
  it("searches every word a person remembers a system by", () => {
    expect(filterSystems(rows, { q: "acme" }).map((r) => r.externalId)).toEqual(["SS-2"]);
    expect(filterSystems(rows, { q: "sg1234" })).toHaveLength(3);
    expect(filterSystems(rows, { q: "sierra" }).map((r) => r.externalId)).toEqual(["SS-5"]);
    expect(filterSystems(rows, { q: "utah" }).map((r) => r.externalId)).toEqual(["SS-5"]);
    expect(filterSystems(rows, { q: "bldg 2", state: "former" }).map((r) => r.externalId)).toEqual(["SS-3"]);
    expect(filterSystems(rows, { q: "nothing here" })).toEqual([]);
  });
});
