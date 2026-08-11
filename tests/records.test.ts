import { describe, it, expect } from "vitest";
import { shelveRecords } from "@/lib/records";

const rec = (kind: string, instrumentId: number | null, id = 0) => ({ id, kind, instrumentId });

describe("shelveRecords", () => {
  it("splits withdrawn shares from handed-on systems", () => {
    const { pastEngagements, previouslyOwned } = shelveRecords(
      [rec("revoked", 1, 10), rec("handoff", 2, 11), rec("revoked", 3, 12)],
      new Set()
    );
    expect(pastEngagements.map((r) => r.id)).toEqual([10, 12]);
    expect(previouslyOwned.map((r) => r.id)).toEqual([11]);
  });

  it("hides a record whose system is still live for this viewer", () => {
    // The reported bug: handoff with "keep the previous owner as a viewer"
    // leaves the seller both a frozen record and the live system.
    const { previouslyOwned } = shelveRecords([rec("handoff", 7, 1)], new Set([7]));
    expect(previouslyOwned).toEqual([]);
  });

  it("shelves the record once the system leaves the viewer's board", () => {
    const { previouslyOwned } = shelveRecords([rec("handoff", 7, 1)], new Set([99]));
    expect(previouslyOwned.map((r) => r.id)).toEqual([1]);
  });

  it("always shelves a record whose system is gone entirely", () => {
    // instrument_id goes null when the system is deleted; nothing left to
    // duplicate, and the dossier still reads on its own.
    const { pastEngagements } = shelveRecords([rec("revoked", null, 5)], new Set([1, 2, 3]));
    expect(pastEngagements.map((r) => r.id)).toEqual([5]);
  });

  it("reads an unrecognized kind as an ended engagement", () => {
    // Rows written before `kind` existed default to 'revoked'; anything else
    // unexpected lands in the same, less-claiming bucket.
    const { pastEngagements, previouslyOwned } = shelveRecords([rec("", 1, 4)], new Set());
    expect(pastEngagements.map((r) => r.id)).toEqual([4]);
    expect(previouslyOwned).toEqual([]);
  });

  it("keeps both shelves when one org holds a record of each kind", () => {
    const { pastEngagements, previouslyOwned } = shelveRecords(
      [rec("handoff", 1, 1), rec("revoked", 2, 2)],
      new Set()
    );
    expect(pastEngagements).toHaveLength(1);
    expect(previouslyOwned).toHaveLength(1);
  });
});
