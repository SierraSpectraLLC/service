import { describe, expect, it } from "vitest";
import { buildDirectory, directoryNames, directoryOrgIds, displayName } from "@/lib/directory";

describe("a name for somebody who has never set one", () => {
  it("uses the one they chose, whenever there is one", () => {
    expect(displayName("Joe Harris", "joe.vincent96@gmail.com")).toBe("Joe Harris");
    expect(displayName("  Bill  ", "b@x.com")).toBe("Bill");
  });

  it("makes something person-shaped out of the address otherwise", () => {
    // An email in an assignee dropdown is a row nobody reads.
    expect(displayName("", "joe.vincent96@gmail.com")).toBe("Joe Vincent");
    expect(displayName(null, "thomas_reed@labzen.com")).toBe("Thomas Reed");
    expect(displayName(undefined, "jrharris@sierraspectra.com")).toBe("Jrharris");
  });

  it("never returns nothing at all", () => {
    expect(displayName("", "@nowhere.com")).toBe("@nowhere.com");
  });
});

describe("whose people you can see", () => {
  // Sierra (operator) with two clients; a second operator with one of its own.
  const all = [
    { id: 1, isOperator: true, tenant: 1 },   // Sierra Spectra
    { id: 2, isOperator: false, tenant: 1 },  // LabZen, a Sierra client
    { id: 3, isOperator: false, tenant: 1 },  // Altis, another Sierra client
    { id: 9, isOperator: true, tenant: 9 },   // a different operator
    { id: 10, isOperator: false, tenant: 9 }, // its client
  ];

  it("shows house staff their whole tenant and no other", () => {
    expect(directoryOrgIds({ orgId: 1, isHouse: true }, all, 1).sort()).toEqual([1, 2, 3]);
  });

  it("shows a client its own people and the provider's", () => {
    // The two sides of a shared system, which is what makes it a shared
    // conversation rather than two logs nobody can address to anybody.
    expect(directoryOrgIds({ orgId: 2, isHouse: false }, all, 1).sort()).toEqual([1, 2]);
  });

  it("never shows one client another client of the same provider", () => {
    expect(directoryOrgIds({ orgId: 2, isHouse: false }, all, 1)).not.toContain(3);
  });

  it("never reaches into another operator's tenant", () => {
    const house = directoryOrgIds({ orgId: 1, isHouse: true }, all, 1);
    expect(house).not.toContain(9);
    expect(house).not.toContain(10);
  });

  it("shows platform staff everybody, since they see every tenant anyway", () => {
    expect(directoryOrgIds({ orgId: 1, isHouse: true }, all, null).sort((a, b) => a - b))
      .toEqual([1, 2, 3, 9, 10]);
  });

  it("gives somebody with no organization at all nobody", () => {
    expect(directoryOrgIds({ orgId: null, isHouse: false }, all, 7)).toEqual([]);
  });
});

describe("two service companies on one client's bench", () => {
  // Sierra (1) services the LC-MS; Acme Engineering (9) services the gas
  // generator; both are shared onto systems at the mutual client, LabZen (2).
  const all = [
    { id: 1, isOperator: true, tenant: 1 },    // Sierra Spectra
    { id: 2, isOperator: false, tenant: 1 },   // LabZen, Sierra's client
    { id: 3, isOperator: false, tenant: 1 },   // Altis, another Sierra client
    { id: 9, isOperator: true, tenant: 9 },    // Acme Engineering
    { id: 10, isOperator: false, tenant: 9 },  // an Acme client
  ];

  it("lets each service company name the other once they share work", () => {
    // Nobody added Acme to Sierra's organization list - there is nothing to add.
    // The share is the relationship, and the directory reads it.
    expect(directoryOrgIds({ orgId: 1, isHouse: true }, all, 1, [9]).sort((a, b) => a - b))
      .toEqual([1, 2, 3, 9]);
    expect(directoryOrgIds({ orgId: 9, isHouse: true }, all, 9, [1, 2]).sort((a, b) => a - b))
      .toEqual([1, 2, 9, 10]);
  });

  it("brings in only the counterparty, never their client list", () => {
    // Sierra can name Acme's people. Acme's OTHER clients are still strangers.
    expect(directoryOrgIds({ orgId: 1, isHouse: true }, all, 1, [9])).not.toContain(10);
  });

  it("lets a client name the visiting company too", () => {
    // LabZen has both on their bench and has to be able to address either.
    expect(directoryOrgIds({ orgId: 2, isHouse: false }, all, 1, [9]).sort((a, b) => a - b))
      .toEqual([1, 2, 9]);
  });

  it("ignores a collaborator this viewer cannot see at all", () => {
    // Defence in depth: the id list is derived from records, and a record whose
    // counterparty is invisible must not put that company in the directory.
    expect(directoryOrgIds({ orgId: 1, isHouse: true }, all, 1, [999])).not.toContain(999);
  });

  it("changes nothing when there is no shared work", () => {
    expect(directoryOrgIds({ orgId: 1, isHouse: true }, all, 1, []).sort()).toEqual([1, 2, 3]);
  });
});

describe("the directory somebody actually sees", () => {
  it("puts your own colleagues first, then other organizations A-Z", () => {
    const d = buildDirectory([
      { name: "Thomas Reed", email: "t@labzen.com", org: "LabZen" },
      { name: "Joe Harris", email: "joe@sierraspectra.com", org: "Sierra Spectra" },
      { name: "Bill Nye", email: "bill@sierraspectra.com", org: "Sierra Spectra" },
    ], "Sierra Spectra");
    expect(directoryNames(d)).toEqual(["Bill Nye", "Joe Harris", "Thomas Reed"]);
  });

  it("is one entry per person, however many lists they are on", () => {
    // Somebody can be staff of the operator and listed on a client.
    const d = buildDirectory([
      { name: "", email: "Joe@Sierra.com", org: "Sierra Spectra" },
      { name: "Joe Harris", email: "joe@sierra.com", org: "Sierra Spectra" },
    ], "Sierra Spectra");
    expect(d).toHaveLength(1);
    expect(d[0].name).toBe("Joe Harris");
    expect(d[0].email).toBe("joe@sierra.com");
  });

  it("qualifies a name two people share", () => {
    // An assignee is stored as text and a mention is matched as text, so two
    // bare Chrises would resolve to whichever came first and notify the wrong
    // one - silently, which is the part that matters.
    const d = buildDirectory([
      { name: "Chris", email: "chris@sierra.com", org: "Sierra Spectra" },
      { name: "Chris", email: "chris@labzen.com", org: "LabZen" },
      { name: "Bill", email: "bill@sierra.com", org: "Sierra Spectra" },
    ], "Sierra Spectra");
    expect(directoryNames(d).sort())
      .toEqual(["Bill", "Chris (LabZen)", "Chris (Sierra Spectra)"]);
  });

  it("leaves a unique name alone, org or no org", () => {
    const d = buildDirectory([{ name: "Bill", email: "b@x.com", org: "Sierra Spectra" }], "Sierra Spectra");
    expect(d[0].name).toBe("Bill");
  });

  it("drops a row with no address, which is not a person anybody can reach", () => {
    expect(buildDirectory([{ name: "Ghost", email: "  ", org: "Sierra Spectra" }], "Sierra Spectra"))
      .toEqual([]);
  });
});
