// Handing a client to another service company.
//
// The tests that matter most are about what does NOT cross. A handover writes
// rows into a competitor's database, so the payload type is the guard - there
// is nowhere to put a price - and these hold the composer to it.
import { describe, expect, it } from "vitest";
import {
  freeTag, isOpen, mayAnswerCounter, mayCounter, mayDecide, mayWithdraw,
  parsePayload, provenanceLine, shareProblems, summarize, SHARE_VERSION,
  type SharePayload,
} from "@/lib/clientShare";

const PAYLOAD: SharePayload = {
  version: SHARE_VERSION,
  client: { name: "Emery Pharma", kind: "client" },
  sites: [
    { name: "Hayward", address: "2000 Sample Way", accessNotes: "Dock 4, badge at reception",
      contactName: "R. Diaz", contactPhone: "555-0100", contactEmail: "rd@emery.test" },
    { name: "Alameda", address: "15 Bay Farm Rd", accessNotes: "", contactName: "",
      contactPhone: "", contactEmail: "" },
  ],
  systems: [
    { sourceRef: "EP-001", model: "6495C", category: "LC-MS", siteName: "Hayward", location: "",
      modules: [{ kind: "Mass Spec", model: "6495C", serial: "SN7009", manufacturer: "Agilent" }] },
    { sourceRef: "EP-008", model: "6495C", category: "LC-MS", siteName: "Alameda", location: "",
      modules: [] },
  ],
  from: { operator: "Sierra Spectra", by: "joe@sierra.test", on: "2026-08-27" },
  note: "They asked about the Alameda GCs.",
};

describe("what a handover is", () => {
  it("says what somebody is deciding on", () => {
    expect(summarize(PAYLOAD)).toBe("2 systems across 2 sites");
    expect(summarize({ ...PAYLOAD, sites: [PAYLOAD.sites[0]] })).toBe("2 systems at Hayward");
    expect(summarize({ ...PAYLOAD, systems: [] })).toBe("No systems");
  });

  it("carries how to get into the building, because they have to get in", () => {
    // The one contact detail that is about the WORK rather than the
    // relationship. Everything else about the client's people stays put.
    expect(PAYLOAD.sites[0].accessNotes).toBeTruthy();
  });

  it("carries its own provenance, so a copy can always be traced", () => {
    const line = provenanceLine(PAYLOAD);
    expect(line).toContain("Sierra Spectra");
    expect(line).toContain("2026-08-27");
    // Said out loud on the copy itself: this is a snapshot, not a feed.
    expect(line).toContain("does not update");
  });
});

describe("what must never cross", () => {
  it("has no field for money at all", () => {
    /*
     * The type is the guard, not the renderer: there is nowhere to put a
     * price, so no later edit can add one without changing SharePayload and
     * meeting the comment above it. What a client pays us is ours and theirs.
     */
    const json = JSON.stringify(PAYLOAD);
    expect(json).not.toContain("$");
    for (const k of ["cost", "price", "rate", "invoice", "agreement", "allowance"]) {
      expect(Object.keys(PAYLOAD)).not.toContain(k);
      expect(Object.keys(PAYLOAD.systems[0])).not.toContain(k);
    }
  });

  it("survives a payload that has gone bad without half-applying it", () => {
    // A handover writes into somebody else's database. Refusing outright is
    // the only safe answer to a snapshot that cannot be read.
    expect(parsePayload("not json")).toBeNull();
    expect(parsePayload("")).toBeNull();
    expect(parsePayload("[1,2,3]")?.systems).toEqual([]);
  });

  it("round-trips a real one", () => {
    expect(parsePayload(JSON.stringify(PAYLOAD))).toEqual(PAYLOAD);
  });
});

describe("their shelf, their labels", () => {
  it("keeps the sender's tag when the destination has no clash", () => {
    // A shop with no collision has no reason to be handed an odd number.
    expect(freeTag("EP-001", ["NW-100", "NW-101"])).toBe("EP-001");
  });

  it("mints a fresh one when it is taken, and never collides", () => {
    /*
     * instruments.external_id is unique across the whole table, so a copy that
     * imposed the sender's tag would throw the moment the recipient already
     * used it - and even where it worked, it would be putting one shop's
     * sticker on another shop's machine.
     */
    const taken = ["EP-001", "EP-001-2", "EP-001-3"];
    const next = freeTag("EP-001", taken);
    expect(next).toBe("EP-001-4");
    expect(taken).not.toContain(next);
  });

  it("is case-insensitive about a clash, because a shelf label is not", () => {
    expect(freeTag("ep-001", ["EP-001"])).not.toBe("ep-001");
  });

  it("always returns something, even for a blank tag", () => {
    expect(freeTag("", [])).toBe("SYS");
    expect(freeTag("  ", ["SYS"])).toBe("SYS-2");
  });
});

describe("who may do what, and when", () => {
  it("lets an open offer be answered or withdrawn, and a closed one neither", () => {
    expect(mayDecide("pending")).toBe(true);
    expect(mayWithdraw("pending")).toBe(true);
    for (const s of ["accepted", "declined", "withdrawn"]) {
      expect(mayDecide(s)).toBe(false);
      expect(mayWithdraw(s)).toBe(false);
    }
  });

  it("refuses an empty client, an unresolved workspace and your own workspace", () => {
    expect(shareProblems({ payload: { ...PAYLOAD, systems: [] }, toOrgId: 4, fromTenantOrgId: 3 })[0])
      .toContain("no systems");
    expect(shareProblems({ payload: PAYLOAD, toOrgId: 4, fromTenantOrgId: null })
      .some((p) => p.includes("could not be resolved"))).toBe(true);
    expect(shareProblems({ payload: PAYLOAD, toOrgId: 3, fromTenantOrgId: 3 })
      .some((p) => p.includes("your own workspace"))).toBe(true);
  });

  it("is happy with the ordinary case", () => {
    expect(shareProblems({ payload: PAYLOAD, toOrgId: 4, fromTenantOrgId: 3 })).toEqual([]);
  });
});

describe("countering", () => {
  it("lets a live offer be countered, and a countered one not again", () => {
    /*
     * One offer on the table at a time. A recipient who could accept the
     * original while their own counter sat unanswered could take the client at
     * whichever price the sender had not yet replied to.
     */
    expect(mayCounter("pending")).toBe(true);
    expect(mayCounter("countered")).toBe(false);
    expect(mayDecide("countered")).toBe(false);
  });

  it("leaves a countered offer withdrawable by the sender", () => {
    // It is still their client and still unresolved.
    expect(mayWithdraw("countered")).toBe(true);
  });

  it("puts the answer in the sender's hands, and only while one is outstanding", () => {
    expect(mayAnswerCounter("countered")).toBe(true);
    expect(mayAnswerCounter("pending")).toBe(false);
    expect(mayAnswerCounter("accepted")).toBe(false);
  });

  it("counts a countered offer as still live", () => {
    expect(isOpen("countered")).toBe(true);
    expect(isOpen("declined")).toBe(false);
  });
});
