// Two chronologies that were one story.
//
// The record kept a Queue card and an Ownership history card. Both answer "who
// has this thing" - one in the sense of whose move it is, one in the sense of
// whose machine it is - and both were drawn with their own heading and their
// own list, so reconstructing what actually happened to a system meant holding
// a date from one card in your head while scrolling to the other.
//
// The shop's read: "they more or less handle the same thing anyway". This is
// the interleave that follows from agreeing.
import { describe, expect, it } from "vitest";
import { custodyLine, type OwnerEvent, type QueueLeg } from "@/lib/custodyLine";

const day = (d: string) => new Date(`${d}T12:00:00Z`);

const leg = (id: number, on: string, from: string, to: string, reason = ""): QueueLeg =>
  ({ id, at: day(on), when: on, fromName: from, toName: to, reason, actor: "jrharris@sierra.test" });

const own = (id: number, on: string, from: string, to: string, kind = "transfer"): OwnerEvent =>
  ({ id, at: day(on), when: on, fromName: from, toName: to, kind, note: "", actor: "joe@sierra.test" });

describe("one list out of two", () => {
  it("interleaves by date rather than by which card it came from", () => {
    const rows = custodyLine(
      [leg(1, "2026-03-02", "Sierra Spectra", "Modesto"), leg(2, "2026-01-10", "Modesto", "Sierra Spectra")],
      [own(1, "2026-02-04", "Puget", "Modesto")],
    );
    expect(rows.map((r) => r.when)).toEqual(["2026-03-02", "2026-02-04", "2026-01-10"]);
  });

  it("says which axis each row is, because a mixed list is unreadable otherwise", () => {
    const rows = custodyLine([leg(1, "2026-03-02", "A", "B")], [own(1, "2026-02-04", "A", "B")]);
    expect(rows.map((r) => r.axis)).toEqual(["queue", "owner"]);
  });

  it("keeps the two id spaces apart", () => {
    // Both tables start at 1. Keyed on the table alone, React would see one
    // row where there are two and drop whichever it drew second.
    const rows = custodyLine([leg(1, "2026-03-02", "A", "B")], [own(1, "2026-03-01", "A", "B")]);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });

  it("carries the reason and the note into the same field", () => {
    // A queue leg calls it a reason and a handoff calls it a note. To a reader
    // they are the same line of prose under the same kind of row.
    const rows = custodyLine(
      [leg(1, "2026-03-02", "A", "B", "Running application tests")],
      [{ ...own(1, "2026-02-04", "A", "B"), note: "Shipped to end customer, PO 4471" }],
    );
    expect(rows.map((r) => r.note)).toEqual(["Running application tests", "Shipped to end customer, PO 4471"]);
  });
});

describe("a handoff writes both at once", () => {
  it("reads as cause then effect when the timestamps tie", () => {
    /*
     * handOffSystem writes a custody event and a queue leg in one transaction,
     * so their timestamps land equal often enough to matter. "Sierra Spectra →
     * Modesto, handed on" followed by the queue move is the story; the other
     * order is two unrelated things that happened to share a second.
     */
    const rows = custodyLine(
      [leg(9, "2026-04-01", "Sierra Spectra", "Modesto")],
      [own(4, "2026-04-01", "Sierra Spectra", "Modesto")],
    );
    expect(rows.map((r) => r.axis)).toEqual(["owner", "queue"]);
  });

  it("orders two rows of the same axis at the same instant by id", () => {
    // Otherwise the panel reorders itself between deploys on whatever the
    // query planner felt like, which reads as history changing.
    const rows = custodyLine(
      [leg(1, "2026-04-01", "A", "B"), leg(2, "2026-04-01", "B", "C")],
      [],
    );
    expect(rows.map((r) => r.key)).toEqual(["q-2", "q-1"]);
  });
});

describe("the halves stand alone", () => {
  it("is just the queue when there is no ownership to show", () => {
    // What a client gets: their own machine's queue, and no roster of the
    // companies it has belonged to. See showOwnership on the panel.
    const rows = custodyLine([leg(1, "2026-03-02", "A", "B")], []);
    expect(rows).toHaveLength(1);
    expect(rows[0].axis).toBe("queue");
  });

  it("is just the ownership when the queue has never moved", () => {
    const rows = custodyLine([], [own(1, "2026-02-04", "", "Puget", "intake")]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("intake");
  });

  it("is empty for a system that has never gone anywhere", () => {
    expect(custodyLine([], [])).toEqual([]);
  });
});
