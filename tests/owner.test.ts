import { describe, expect, it } from "vitest";
import {
  clientAfterHandoff, orgNamed, ownerFields, ownerLabel, ownerMismatch,
} from "@/lib/owner";

const ORGS = [
  { id: 1, name: "Sierra Spectra" },
  { id: 2, name: "LabZen" },
  { id: 3, name: "Modesto Irrigation District" },
];

describe("choosing an owner", () => {
  it("takes the organization's own name, whatever was typed before", () => {
    // This is what makes the pair unable to drift: the label is not a second
    // thing somebody maintains, it is a consequence of the link.
    expect(ownerFields(2, "labzen llc", ORGS)).toEqual({ orgId: 2, name: "LabZen" });
    expect(ownerFields(2, "", ORGS)).toEqual({ orgId: 2, name: "LabZen" });
  });

  it("keeps a plain name for a company that is not on the platform", () => {
    // The case that is genuinely free text, and the reason the column survives.
    expect(ownerFields(null, "  Bob's Analytical  ", ORGS))
      .toEqual({ orgId: null, name: "Bob's Analytical" });
  });

  it("is unowned when nothing is chosen and nothing is typed", () => {
    expect(ownerFields(null, "", ORGS)).toEqual({ orgId: null, name: "" });
  });

  it("resolves a link to an organization that is gone as unowned", () => {
    // A dangling id grants nothing, so it must not claim to own anything.
    expect(ownerFields(99, "LabZen", ORGS)).toEqual({ orgId: null, name: "LabZen" });
  });

  it("does not let a typed name grow without limit", () => {
    expect(ownerFields(null, "x".repeat(400), ORGS).name).toHaveLength(120);
  });
});

describe("what a record says it belongs to", () => {
  it("prints the name, or says plainly that there is none", () => {
    expect(ownerLabel({ orgId: 2, name: "LabZen" })).toBe("LabZen");
    expect(ownerLabel({ orgId: null, name: "Bob's Analytical" })).toBe("Bob's Analytical");
    expect(ownerLabel({ orgId: null, name: "" })).toBe("Unassigned");
  });
});

describe("rows written before there was one control", () => {
  it("spots a label that disagrees with the link", () => {
    // The screenshot: the form said LabZen, the ownership row said Unassigned,
    // and both were true - the label said LabZen and LabZen could not see it.
    expect(ownerMismatch(2, "Modesto Irrigation District", ORGS)).toBe("LabZen");
    expect(ownerMismatch(2, "", ORGS)).toBe("LabZen");
  });

  it("is quiet when they agree, however they were capitalised", () => {
    expect(ownerMismatch(2, "LabZen", ORGS)).toBe("");
    expect(ownerMismatch(2, "  labzen ", ORGS)).toBe("");
  });

  it("has nothing to say about a record nobody owns", () => {
    expect(ownerMismatch(null, "Bob's Analytical", ORGS)).toBe("");
    expect(ownerMismatch(99, "LabZen", ORGS)).toBe("");
  });
});

describe("offering to link a name to the organization of that name", () => {
  it("finds the organization somebody clearly meant", () => {
    expect(orgNamed("labzen", ORGS)?.id).toBe(2);
    expect(orgNamed("  LabZen  ", ORGS)?.id).toBe(2);
  });

  it("finds nothing for a company that is not on the platform", () => {
    expect(orgNamed("Bob's Analytical", ORGS)).toBe(null);
    expect(orgNamed("", ORGS)).toBe(null);
    expect(orgNamed("   ", ORGS)).toBe(null);
  });
});

describe("the client label when a system changes hands", () => {
  it("follows the owner when it was naming the owner", () => {
    // The usual case, and the bug: a transfer moved ownership to Acme and left
    // the system reading "Client: LabZen" to everybody who opened it.
    expect(clientAfterHandoff("LabZen", "LabZen", "Acme Engineering")).toBe("Acme Engineering");
    expect(clientAfterHandoff("  labzen ", "LabZen", "Acme Engineering")).toBe("Acme Engineering");
  });

  it("fills in a blank label", () => {
    expect(clientAfterHandoff("", "LabZen", "Acme Engineering")).toBe("Acme Engineering");
    expect(clientAfterHandoff("   ", "", "Acme Engineering")).toBe("Acme Engineering");
  });

  it("leaves a label somebody set deliberately", () => {
    // The whole reason the two columns exist: we own the unit on the bench and
    // the work is for somebody else. A transfer is not the moment to overrule
    // whoever wrote that down.
    expect(clientAfterHandoff("Modesto Irrigation District", "Sierra Spectra", "Acme Engineering"))
      .toBe("Modesto Irrigation District");
  });

  it("treats a handoff from nobody as ownership taking hold", () => {
    // House-stewarded: no outgoing owner to have been tracking, so an existing
    // label is somebody's own words and stays.
    expect(clientAfterHandoff("Prospect - Altis", "", "Acme Engineering")).toBe("Prospect - Altis");
  });
});
