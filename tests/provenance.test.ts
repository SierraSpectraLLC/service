import { describe, it, expect } from "vitest";
import {
  cleanProvenance, isPublishable, PROVENANCE_CHOICES, PROVENANCE_LABEL,
  tallyLine, tallyProvenance,
} from "@/lib/provenance";

describe("cleanProvenance", () => {
  it("keeps the four known values", () => {
    for (const p of ["", "original", "facts", "oem"]) expect(cleanProvenance(p)).toBe(p);
  });

  it("turns anything unknown, null or undefined into unreviewed", () => {
    // The safe direction: an unrecognized string must never read as licensable.
    expect(cleanProvenance("ours!")).toBe("");
    expect(cleanProvenance(null)).toBe("");
    expect(cleanProvenance(undefined)).toBe("");
    expect(cleanProvenance("ORIGINAL")).toBe("");
  });

  it("trims", () => {
    expect(cleanProvenance("  facts ")).toBe("facts");
  });
});

describe("isPublishable", () => {
  it("passes our own work and our own restatement of facts", () => {
    expect(isPublishable("original")).toBe(true);
    expect(isPublishable("facts")).toBe(true);
  });

  it("refuses OEM material, unreviewed rows, and junk", () => {
    expect(isPublishable("oem")).toBe(false);
    expect(isPublishable("")).toBe(false);
    expect(isPublishable(undefined)).toBe(false);
    expect(isPublishable("definitely-fine")).toBe(false);
  });
});

describe("PROVENANCE_CHOICES", () => {
  it("offers the three real answers, never the unreviewed placeholder", () => {
    expect(PROVENANCE_CHOICES).toEqual(["original", "facts", "oem"]);
    expect(PROVENANCE_CHOICES).not.toContain("");
  });

  it("every value has a label", () => {
    for (const c of ["", ...PROVENANCE_CHOICES]) expect(PROVENANCE_LABEL[c as ""]).toBeTruthy();
  });
});

describe("tallyProvenance", () => {
  const rows = [
    { provenance: "original" }, { provenance: "original" }, { provenance: "facts" },
    { provenance: "oem" }, { provenance: "" }, { provenance: "junk" },
  ];

  it("counts the licensable set and what is still unclassified", () => {
    const t = tallyProvenance(rows);
    expect(t.total).toBe(6);
    expect(t.publishable).toBe(3);
    // Junk lands in unreviewed with the genuinely blank one.
    expect(t.unreviewed).toBe(2);
    expect(t.byKind.oem).toBe(1);
  });

  it("handles rows with no column at all", () => {
    expect(tallyProvenance([{}, {}]).unreviewed).toBe(2);
  });
});

describe("tallyLine", () => {
  it("leads with what is clear, then what still needs a decision", () => {
    expect(tallyLine(tallyProvenance([
      { provenance: "original" }, { provenance: "" }, { provenance: "oem" },
    ]))).toBe("1 of 3 clear to license · 1 unreviewed · 1 OEM");
  });

  it("says only the useful half when everything is cleared", () => {
    expect(tallyLine(tallyProvenance([{ provenance: "facts" }]))).toBe("1 of 1 clear to license");
  });

  it("is empty with nothing filed, so the header shows nothing", () => {
    expect(tallyLine(tallyProvenance([]))).toBe("");
  });
});
