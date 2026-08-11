import { describe, expect, it } from "vitest";
import { includesSystem } from "@/lib/eodEmail";

// Regression guard, twice over.
//
// First: grouping the daily report by client built the list from CURRENTLY
// ACTIVE systems, so as soon as a system shipped or was archived its recorded
// updates vanished from the history pages. Since shipping is the normal end
// state, that quietly erased most of the archive.
//
// Then, less obviously, history still read CURRENT OWNERSHIP. Handing a system
// to its buyer moved every past update with it: yesterday's report went blank
// for the client who paid for the work and reappeared under a new owner who had
// never seen the instrument. `recordedIds` is now "what this org recorded that
// day", read off the stamp on the saved row, and history consults nothing else.

const sys = (over: Partial<Parameters<typeof includesSystem>[0]> = {}) => ({
  id: 1, ownerOrgId: 5, archived: false, stages: ["Refurbishment"], lead: "Joe", ...over,
});
const none = new Set<string>();

describe("who lands on a client's daily report", () => {
  it("live: active systems the client owns", () => {
    expect(includesSystem(sys(), 5, false, new Set(), none)).toBe(true);
  });

  it("live: shipped, archived and client-led systems drop off", () => {
    expect(includesSystem(sys({ stages: ["Shipped"] }), 5, false, new Set(), none)).toBe(false);
    expect(includesSystem(sys({ archived: true }), 5, false, new Set(), none)).toBe(false);
    expect(includesSystem(sys({ lead: "Chris" }), 5, false, new Set(), new Set(["Chris"]))).toBe(false);
  });

  it("history: a recorded update survives shipping, archiving and a client lead", () => {
    const recorded = new Set([1]);
    expect(includesSystem(sys({ stages: ["Shipped"] }), 5, true, recorded, none)).toBe(true);
    expect(includesSystem(sys({ archived: true }), 5, true, recorded, none)).toBe(true);
    expect(includesSystem(sys({ lead: "Chris" }), 5, true, recorded, new Set(["Chris"]))).toBe(true);
  });

  it("history: a system that recorded nothing that day stays off", () => {
    expect(includesSystem(sys(), 5, true, new Set(), none)).toBe(false);
    expect(includesSystem(sys(), 5, true, new Set([2]), none)).toBe(false);
  });

  it("live: never crosses clients", () => {
    expect(includesSystem(sys({ ownerOrgId: 7 }), 5, false, new Set(), none)).toBe(false);
  });

  it("history: a since-sold system stays on the report of the client it was written for", () => {
    // The reported bug. The system belongs to org 7 today; org 5 recorded the
    // update on the day in question, so it is org 5's line and nobody else's.
    expect(includesSystem(sys({ ownerOrgId: 7 }), 5, true, new Set([1]), none)).toBe(true);
    // And it must NOT appear on the new owner's report for that day - their set
    // is built from their own stamped rows, which don't include it.
    expect(includesSystem(sys({ ownerOrgId: 7 }), 7, true, new Set(), none)).toBe(false);
  });

  it("house-stewarded work groups under the operator (orgId null)", () => {
    expect(includesSystem(sys({ ownerOrgId: null }), null, false, new Set(), none)).toBe(true);
    expect(includesSystem(sys({ ownerOrgId: null }), 5, false, new Set(), none)).toBe(false);
  });
});
