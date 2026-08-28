// Handing a client to another service company.
//
// The tests that matter most are about what does NOT cross. A handover writes
// rows into a competitor's database, so the payload type is the guard - there
// is nowhere to put a price - and these hold the composer to it.
import { describe, expect, it } from "vitest";
import {
  blindSummary, freeTag, identifyingBits, isOpen, mayAnswerCounter, mayCounter,
  mayDecide, mayWithdraw, noteLeaks, parsePayload, provenanceLine, redactPayload,
  shareProblems, stateOf, summarize, SHARE_VERSION, type SharePayload,
} from "@/lib/clientShare";

const PAYLOAD: SharePayload = {
  version: SHARE_VERSION,
  client: { name: "Emery Pharma", kind: "client" },
  sites: [
    { name: "Hayward", address: "2000 Sample Way, Hayward CA 94544",
      accessNotes: "Dock 4, badge at reception",
      contactName: "R. Diaz", contactPhone: "555-0100", contactEmail: "rd@emery.test" },
    { name: "Alameda", address: "15 Bay Farm Rd, Alameda CA 94502", accessNotes: "",
      contactName: "", contactPhone: "", contactEmail: "" },
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

describe("a blind offer", () => {
  const blind = redactPayload(PAYLOAD);

  it("takes out everything they would need to go round the sender", () => {
    /*
     * The point of a referral fee is that the other shop cannot approach the
     * client directly. The full list hands them the company, the street, the
     * person to ask for, and serials a manufacturer will match to an owner.
     */
    const json = JSON.stringify(blind);
    expect(json).not.toContain("Emery Pharma");
    expect(json).not.toContain("2000 Sample Way");
    expect(json).not.toContain("R. Diaz");
    expect(json).not.toContain("rd@emery.test");
    expect(json).not.toContain("555-0100");
    expect(json).not.toContain("SN7009");
    // Asset tags look innocuous and are not: a tag on a service report or a
    // photo identifies the machine, and the machine identifies the lab.
    expect(json).not.toContain("EP-001");
  });

  it("keeps enough to decide whether you want the work", () => {
    expect(blind.systems).toHaveLength(PAYLOAD.systems.length);
    expect(blind.systems[0].model).toBe("6495C");
    expect(blind.systems[0].category).toBe("LC-MS");
    expect(blind.systems[0].modules[0].manufacturer).toBe("Agilent");
    expect(blind.sites).toHaveLength(2);
  });

  it("says the state and never the street", () => {
    expect(stateOf("2000 Sample Way, Hayward CA 94544")).toBe("CA");
    expect(stateOf("15 Bay Farm Rd\nAlameda, CA")).toBe("CA");
    expect(stateOf("331 Fort Johnson Road, Charleston, SC 29412")).toBe("SC");
    // Unreadable comes back blank rather than guessed.
    expect(stateOf("somewhere out past the airport")).toBe("");
    expect(stateOf("")).toBe("");
  });

  it("summarises without naming anybody", () => {
    expect(blindSummary(PAYLOAD)).toBe("2 systems across 2 sites in CA");
    const noState = { ...PAYLOAD, sites: [{ ...PAYLOAD.sites[0], address: "out past the airport" }] };
    expect(blindSummary(noState)).toContain("region not stated");
  });

  it("still round-trips as a payload, so nothing downstream has to know", () => {
    expect(parsePayload(JSON.stringify(blind))).toEqual(blind);
  });
});

describe("the covering note, which travels beside the offer", () => {
  it("catches a note that names the client", () => {
    /*
     * The hole redaction left. The payload was blinded and the note went
     * across untouched - onto their screen and into the email - so a sender
     * who was told the name would be held back had it forwarded for them.
     */
    expect(noteLeaks("Emery Pharma want the GCs covered", PAYLOAD)).toContain("Emery Pharma");
    expect(noteLeaks("they want the GCs covered", PAYLOAD)).toEqual([]);
  });

  it("catches every other thing blinding takes out", () => {
    expect(noteLeaks("meet R. Diaz at the dock", PAYLOAD)).toContain("R. Diaz");
    expect(noteLeaks("ring 555-0100 first", PAYLOAD)).toContain("555-0100");
    expect(noteLeaks("rd@emery.test knows the site", PAYLOAD)).toContain("rd@emery.test");
    expect(noteLeaks("the one at 2000 Sample Way", PAYLOAD)).toContain("2000 Sample Way");
    expect(noteLeaks("SN7009 is the newer one", PAYLOAD)).toContain("SN7009");
    expect(noteLeaks("start with the Hayward pair", PAYLOAD)).toContain("Hayward");
  });

  it("does not care how it was capitalized", () => {
    // A sender typing "emery pharma" has given away exactly as much.
    expect(noteLeaks("emery pharma are moving", PAYLOAD)).toContain("Emery Pharma");
  });

  it("leaves short strings alone, so it is not a warning people click through", () => {
    /*
     * Initials and door numbers match everything. A check that fired on "Al"
     * would fire on "also", and a warning that fires on every offer is one
     * people learn to click through - which costs more than it saves.
     */
    const tiny: SharePayload = {
      ...PAYLOAD,
      client: { name: "AB", kind: "client" },
      sites: [{ ...PAYLOAD.sites[0], name: "Lab", address: "44", contactName: "Al",
        contactPhone: "", contactEmail: "" }],
      systems: [],
    };
    expect(identifyingBits(tiny)).toEqual([]);
    expect(noteLeaks("Al is at the Lab, 44, and AB is also fine", tiny)).toEqual([]);
  });

  it("lists what is identifying without listing what is published anyway", () => {
    const bits = identifyingBits(PAYLOAD);
    expect(bits).toContain("Emery Pharma");
    expect(bits).toContain("SN7009");
    // The model and the category survive blinding, so they are not leaks - a
    // note is free to say "the two 6495Cs".
    expect(bits).not.toContain("6495C");
    expect(bits).not.toContain("LC-MS");
  });
});
