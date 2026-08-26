import { describe, expect, it } from "vitest";
import {
  MAKE_STATES, ORDER_STATES, PART_STATES, PART_TONE, isMadeState, partOpen,
} from "@/lib/stages";
import { partDates } from "@/lib/partGroups";

/**
 * The second way a part arrives.
 *
 * The list was a procurement pipeline end to end, which is right until a
 * client stops buying a bracket and starts printing it - and then every word
 * in it is wrong. The cases here are the ones that would quietly reintroduce
 * the buying assumption: a made part treated as still on order, a made part
 * treated as received, or a made part that no chase list ever mentions.
 */

describe("the two lanes", () => {
  it("share both ends and nothing in between", () => {
    // Needed is the moment of commitment either way; Installed and Removed are
    // how a part ends however it got here. Everything between belongs to one
    // lane or the other, and no status belongs to both.
    const both = (ORDER_STATES as readonly string[])
      .filter((s) => (MAKE_STATES as readonly string[]).includes(s));
    expect(both).toEqual([]);
    for (const shared of ["Suggested", "Needed", "Installed", "Removed"]) {
      expect(PART_STATES as readonly string[]).toContain(shared);
      expect(ORDER_STATES as readonly string[]).not.toContain(shared);
      expect(MAKE_STATES as readonly string[]).not.toContain(shared);
    }
  });

  it("keeps every status that already existed", () => {
    // Additive: a row stored before this change still reads.
    for (const s of ["Suggested", "Needed", "Ordered", "In transit", "Received",
      "Backordered", "Installed", "Removed"]) {
      expect(PART_STATES as readonly string[]).toContain(s);
    }
  });

  it("gives every status a tone, including the new ones", () => {
    // A status with no tone renders as a grey pill that says nothing - the
    // silent way a new state half-ships.
    for (const s of PART_STATES) expect(PART_TONE[s], s).toBeTruthy();
  });
});

describe("what still needs somebody", () => {
  it("counts a part on the printer as open", () => {
    expect(partOpen("Being made")).toBe(true);
  });

  it("closes a part that has been made, exactly as Received does", () => {
    // It exists and it is in somebody's hand; the only thing left is fitting
    // it, which is the install step rather than a chase.
    expect(partOpen("Made")).toBe(false);
    expect(partOpen("Received")).toBe(false);
  });

  it("still counts everything that was open before", () => {
    for (const s of ["Suggested", "Needed", "Ordered", "In transit", "Backordered"]) {
      expect(partOpen(s), s).toBe(true);
    }
    for (const s of ["Installed", "Removed"]) expect(partOpen(s), s).toBe(false);
  });
});

describe("the arrival stamp", () => {
  const blank = { status: "Being made", receivedAt: "", madeAt: "", installedAt: "", removedAt: "" };

  it("dates a part the day it was MADE, not the day it was received", () => {
    // Separate fields on purpose: a part nobody sent was never received, and
    // one column doing both jobs is a record that cannot say which happened.
    const d = partDates(blank, "Made", {}, "2026-08-26");
    expect(d.madeAt).toBe("2026-08-26");
    expect(d.receivedAt).toBe("");
  });

  it("does not restamp a part that was already made", () => {
    const already = { ...blank, status: "Made", madeAt: "2026-08-01" };
    expect(partDates(already, "Made", {}, "2026-08-26").madeAt).toBe("2026-08-01");
  });

  it("leaves the made date alone when a bought part is received", () => {
    const bought = { status: "In transit", receivedAt: "", madeAt: "", installedAt: "", removedAt: "" };
    const d = partDates(bought, "Received", {}, "2026-08-26");
    expect(d.receivedAt).toBe("2026-08-26");
    expect(d.madeAt).toBe("");
  });

  it("carries a made date through to install", () => {
    const made = { status: "Made", receivedAt: "", madeAt: "2026-08-20", installedAt: "", removedAt: "" };
    const d = partDates(made, "Installed", {}, "2026-08-26");
    expect(d.madeAt).toBe("2026-08-20");
    expect(d.installedAt).toBe("2026-08-26");
  });

  it("reads a row stored before the column existed", () => {
    const old = { status: "Received", receivedAt: "2026-01-02", installedAt: "", removedAt: "" };
    expect(partDates(old, "Installed", {}, "2026-08-26").madeAt).toBe("");
  });
});

describe("classifying a status", () => {
  it("names the made lane and nothing else", () => {
    expect(isMadeState("Being made")).toBe(true);
    expect(isMadeState("Made")).toBe(true);
    for (const s of ["Needed", "Ordered", "In transit", "Received", "Backordered", "Installed"]) {
      expect(isMadeState(s), s).toBe(false);
    }
  });
});
