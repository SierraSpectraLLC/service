import { describe, expect, it } from "vitest";
import { includesSystem } from "@/lib/eodEmail";

// Regression guard. Grouping the daily report by client introduced a bug: the
// list was built from CURRENTLY ACTIVE systems, so as soon as a system shipped
// or was archived its recorded updates vanished from the history pages. Since
// shipping is the normal end state, that quietly erased most of the archive.
// History must be driven by what was written, not by today's activity filters.

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

  it("never crosses clients, live or historical", () => {
    expect(includesSystem(sys({ ownerOrgId: 7 }), 5, false, new Set(), none)).toBe(false);
    expect(includesSystem(sys({ ownerOrgId: 7 }), 5, true, new Set([1]), none)).toBe(false);
  });

  it("house-stewarded work groups under the operator (orgId null)", () => {
    expect(includesSystem(sys({ ownerOrgId: null }), null, false, new Set(), none)).toBe(true);
    expect(includesSystem(sys({ ownerOrgId: null }), 5, false, new Set(), none)).toBe(false);
  });
});
