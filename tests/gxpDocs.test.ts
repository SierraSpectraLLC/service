import { describe, expect, it } from "vitest";
import {
  canApprove, canDelete, canExecute, canRevokeApproval, isProtocol,
  packageComplete, packageForSystem, packageRows,
} from "@/lib/gxp";

const doc = (docType: string, state: string, version = 1) => ({ docType, state, version });

describe("what may happen to a document", () => {
  it("approves only drafts and executes only approved protocols", () => {
    expect(canApprove(doc("IQ Protocol", "Draft"))).toBe(true);
    expect(canApprove(doc("IQ Protocol", "Approved"))).toBe(false);
    expect(canExecute(doc("IQ Protocol", "Approved"))).toBe(true);
    expect(canExecute(doc("IQ Report", "Approved"))).toBe(false); // reports are not run
    expect(canExecute(doc("IQ Protocol", "Draft"))).toBe(false);  // pre-approval execution is the finding
  });

  it("lets an approval be withdrawn only before execution", () => {
    // After execution the record moves forward by superseding, never by
    // un-signing - a run that happened, happened.
    expect(canRevokeApproval(doc("OQ Protocol", "Approved"))).toBe(true);
    expect(canRevokeApproval(doc("OQ Protocol", "Executed"))).toBe(false);
  });

  it("deletes only an unsigned draft; the rest supersede", () => {
    expect(canDelete(doc("URS", "Draft"), 0)).toBe(true);
    expect(canDelete(doc("URS", "Draft"), 1)).toBe(false);
    expect(canDelete(doc("URS", "Approved"), 0)).toBe(false);
  });

  it("knows a protocol by its name", () => {
    expect(isProtocol("OQ Protocol")).toBe(true);
    expect(isProtocol("OQ Report")).toBe(false);
    expect(isProtocol("Calibration Certificate")).toBe(false);
  });
});

describe("the checklist", () => {
  const required = ["IQ Protocol", "OQ Protocol", "OQ Report"];

  it("is satisfied by approved or executed current documents, never drafts", () => {
    const rows = packageRows(required, [
      doc("IQ Protocol", "Executed"),
      doc("OQ Protocol", "Approved"),
      doc("OQ Report", "Draft"),
    ]);
    expect(rows.map((r) => [r.docType, r.satisfied])).toEqual([
      ["IQ Protocol", true], ["OQ Protocol", true], ["OQ Report", false],
    ]);
    expect(packageComplete(required, [doc("IQ Protocol", "Executed"), doc("OQ Protocol", "Approved"), doc("OQ Report", "Draft")])).toBe(false);
  });

  it("ignores superseded revisions and shows the newest current version first", () => {
    const rows = packageRows(["IQ Protocol"], [
      doc("IQ Protocol", "Superseded", 1),
      doc("IQ Protocol", "Approved", 2),
    ]);
    expect(rows[0].docs.map((d) => d.version)).toEqual([2]);
    expect(rows[0].satisfied).toBe(true);
  });

  it("lists paper on file beyond the declared package, marked as extra", () => {
    const rows = packageRows(["IQ Protocol"], [doc("Calibration Certificate", "Approved")]);
    expect(rows.map((r) => [r.docType, r.required])).toEqual([
      ["IQ Protocol", true], ["Calibration Certificate", false],
    ]);
  });

  it("declares no verdict when no package is declared", () => {
    // The tags and standing work without the doc manager; an empty declaration
    // must not read as "package complete".
    expect(packageComplete([], [doc("URS", "Approved")])).toBeNull();
  });
});

describe("the package a system owes, from the catalog", () => {
  const terms = [
    { kind: "model", assetType: "Mass Spec", name: "Thermo Altis", docTypes: ["IQ Protocol", "OQ Protocol"] },
    { kind: "category", assetType: "", name: "LC-MS", docTypes: ["URS", "OQ Protocol"] },
    { kind: "model", assetType: "Pump", name: "LC-20ADXR", docTypes: [] },
  ];

  it("unions the system type's package with its units', deduped, in binder order", () => {
    expect(packageForSystem(terms, "LC-MS", [
      { kind: "Mass Spec", model: "Thermo Altis" },
      { kind: "Pump", model: "LC-20ADXR" },
    ])).toEqual(["URS", "IQ Protocol", "OQ Protocol"]);
  });

  it("owes nothing when nothing is declared", () => {
    expect(packageForSystem(terms, "TOC", [{ kind: "Pump", model: "LC-20ADXR" }])).toEqual([]);
  });
});
