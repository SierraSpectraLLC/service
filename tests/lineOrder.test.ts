import { describe, expect, it } from "vitest";
import { orderOf } from "@/lib/billing";

/**
 * The positions to write after somebody reorders a document's lines.
 *
 * Position is what the paper prints in, and the paper argues top to bottom:
 * the system, then the modules it covers, then the labor, then the travel.
 * The order a line was typed in is rarely the order it should read in.
 */
const rows = [
  { id: 10, position: 0 }, { id: 11, position: 1 }, { id: 12, position: 2 }, { id: 13, position: 3 },
];

describe("reordering lines", () => {
  it("writes only the positions that change", () => {
    // 12 carried to the top: 12, 10 and 11 move; 13 stays put and is not written.
    expect(orderOf(rows, [12, 10, 11, 13])).toEqual([
      { id: 12, position: 0 }, { id: 10, position: 1 }, { id: 11, position: 2 },
    ]);
  });

  it("writes nothing for a drag that put a line back where it was", () => {
    // Nothing to write, so nothing to audit: "reordered the lines" on a document
    // whose lines did not move is a history nobody can read.
    expect(orderOf(rows, [10, 11, 12, 13])).toEqual([]);
  });

  it("keeps a line a stale screen never saw, after the ones it named", () => {
    // The screen that sent this order was open before line 13 was added by
    // somebody else. That is not an instruction to lose it.
    expect(orderOf(rows, [11, 10, 12])).toEqual([
      { id: 11, position: 0 }, { id: 10, position: 1 },
    ]);
    // ...and 13 is still last, unwritten because it did not move.
  });

  it("ignores ids the document does not own, and a repeat", () => {
    expect(orderOf(rows, [99, 13, 13, 10, 11, 12])).toEqual([
      { id: 13, position: 0 }, { id: 10, position: 1 }, { id: 11, position: 2 }, { id: 12, position: 3 },
    ]);
  });

  it("is quiet about an empty document", () => {
    expect(orderOf([], [1, 2])).toEqual([]);
  });
});
