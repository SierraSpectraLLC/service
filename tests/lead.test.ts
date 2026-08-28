// Selling an enquiry you are never going to drive to.
//
// A lead is sold blind, so the thing worth holding down is the SHAPE of what
// leaves: publicOnly is the only object a shop that has not paid ever gets,
// and a field it does not carry cannot be rendered by mistake. The rest is
// the race - four shops, one lab, one winner.
import { describe, expect, it } from "vitest";
import {
  blurbLeaks, equipmentLine, leadLine, leadProblems, leadSummary, mayClaim, mayWithdrawLead,
  parseSystems, publicOnly, serializeSystems, systemCount,
  type LeadPrivate, type LeadPublic, type LeadSystem,
} from "@/lib/lead";
import type { FeeTerms } from "@/lib/referral";
import { formatCents } from "@/lib/money";

const TERMS: FeeTerms = {
  kind: "percent", feeCents: 0, feeBps: 500, windowMonths: 12,
  minCents: 0, maxCents: 0, note: "",
};

const SYSTEMS: LeadSystem[] = [
  { category: "LC-MS", model: "API 5000", count: 4 },
  { category: "LC", model: "1260 Infinity", count: 1 },
];

const LEAD: LeadPublic & LeadPrivate = {
  region: "Boston metro",
  blurb: "Two labs, no PM cover since their FSE left.",
  systems: SYSTEMS,
  terms: TERMS,
  contactName: "Dr. P. Osei",
  contactEmail: "posei@xyzbio.test",
  contactPhone: "555-0142",
  orgName: "XYZ Biosciences",
  address: "44 Kendall St, Cambridge MA 02142",
};

describe("what is published", () => {
  it("says what the work is and roughly where, and never who", () => {
    expect(leadSummary(LEAD)).toBe("5 systems · Boston metro");
    expect(equipmentLine(SYSTEMS)).toBe("4 × API 5000, 1260 Infinity");
    expect(systemCount(SYSTEMS)).toBe(5);
  });

  it("counts machines rather than lines, because that is what a shop sorts on", () => {
    // Four triple quads at one address is a week of work; four lines could be
    // four singles. The count is the number that decides whether to drive.
    expect(systemCount([{ category: "", model: "5000", count: 4 }])).toBe(4);
    expect(systemCount([])).toBe(0);
  });

  it("says so plainly when the finder listed no equipment", () => {
    expect(equipmentLine([])).toBe("Equipment not listed");
    expect(leadSummary({ region: "", systems: [] })).toBe("Equipment not listed");
  });

  it("puts the fee in the line a shop decides on", () => {
    const line = leadLine(LEAD, formatCents);
    expect(line).toContain("Boston metro");
    expect(line).toContain("API 5000");
    expect(line).toContain("5%");
    // And still nothing that would let them ring the lab instead.
    expect(line).not.toContain("XYZ");
    expect(line).not.toContain("Kendall");
  });
});

describe("blind until claimed", () => {
  it("hands out an object that has never held the contact details", () => {
    /*
     * Not hidden by a screen - ABSENT. The finder's fee is worth something
     * only while the finder is the only route to the lab, so a renderer that
     * is careless with an unexpected field has nothing to be careless with.
     */
    const shown = publicOnly(LEAD);
    expect(Object.keys(shown).sort()).toEqual(["blurb", "region", "systems", "terms"]);
    for (const key of ["contactName", "contactEmail", "contactPhone", "orgName", "address"]) {
      expect(shown).not.toHaveProperty(key);
    }
  });

  it("keeps every published field, so the offer is still worth reading", () => {
    const shown = publicOnly(LEAD);
    expect(shown.region).toBe("Boston metro");
    expect(shown.blurb).toContain("no PM cover");
    expect(shown.systems).toHaveLength(2);
    expect(shown.terms.feeBps).toBe(500);
  });

  it("survives being serialized, which is how it reaches a browser", () => {
    // A component takes this over the wire; anything the object still carries
    // would arrive with it.
    const wire = JSON.stringify(publicOnly(LEAD));
    expect(wire).not.toContain("osei");
    expect(wire).not.toContain("XYZ");
    expect(wire).not.toContain("555-0142");
  });
});

describe("first to claim wins", () => {
  const open = { status: "open", tenantOrgId: 3 };

  it("is open to a shop it was offered to", () => {
    expect(mayClaim(open, 4)).toBe(true);
  });

  it("is never claimable by the shop that posted it", () => {
    expect(mayClaim(open, 3)).toBe(false);
  });

  it("is gone once somebody has taken it", () => {
    // Four shops telephoning one lab in a week is worse for the lab than
    // never having been referred, so the losers are told plainly.
    expect(mayClaim({ status: "claimed", tenantOrgId: 3 }, 4)).toBe(false);
    expect(mayClaim({ status: "withdrawn", tenantOrgId: 3 }, 4)).toBe(false);
  });

  it("lets the finder pull it only while nobody has it", () => {
    expect(mayWithdrawLead("open")).toBe(true);
    expect(mayWithdrawLead("claimed")).toBe(false);
    expect(mayWithdrawLead("withdrawn")).toBe(false);
  });
});

describe("what a lead has to have before it can be sold", () => {
  const ok = {
    region: "Boston metro", systems: SYSTEMS, terms: TERMS,
    contactEmail: "posei@xyzbio.test", contactPhone: "", orgName: "XYZ Biosciences",
  };

  it("accepts one that could actually be acted on", () => {
    expect(leadProblems(ok)).toEqual([]);
  });

  it("insists on a way to reach somebody, because that is what is being bought", () => {
    /*
     * Checked at the selling end: the buyer cannot see these fields until
     * they have committed, so they cannot discover for themselves that the
     * lead is a rumour.
     */
    expect(leadProblems({ ...ok, contactEmail: "", contactPhone: "" })[0])
      .toContain("email or a phone");
    // Either one alone is enough - plenty of enquiries arrive by telephone.
    expect(leadProblems({ ...ok, contactEmail: "", contactPhone: "555-0142" })).toEqual([]);
  });

  it("insists on a region, or no shop can tell whether it is theirs", () => {
    expect(leadProblems({ ...ok, region: "  " })[0]).toContain("where it is");
  });

  it("insists on equipment and on the company's name", () => {
    expect(leadProblems({ ...ok, systems: [] })[0]).toContain("what equipment");
    expect(leadProblems({ ...ok, orgName: "" }).join(" ")).toContain("company's name");
  });

  it("refuses a lead offered for nothing", () => {
    // A free lead is a forwarded email, which needs no software.
    const none: FeeTerms = { ...TERMS, kind: "none" };
    expect(leadProblems({ ...ok, terms: none }).join(" ")).toContain("finder's fee");
  });

  it("carries the fee terms' own objections through", () => {
    const upsideDown: FeeTerms = { ...TERMS, minCents: 1_000_000, maxCents: 100_000 };
    expect(leadProblems({ ...ok, terms: upsideDown }).length).toBeGreaterThan(0);
  });
});

describe("the equipment list, which arrives as free text", () => {
  it("round-trips", () => {
    expect(parseSystems(serializeSystems(SYSTEMS))).toEqual(SYSTEMS);
    expect(serializeSystems([])).toBe("");
  });

  it("treats rubbish as no list rather than crashing a page", () => {
    // This column is read on every render of the board; a stray character in
    // one row must not take the other shops' leads down with it.
    expect(parseSystems("")).toEqual([]);
    expect(parseSystems("not json")).toEqual([]);
    expect(parseSystems('{"category":"LC"}')).toEqual([]);
    expect(parseSystems("[null, 7]")).toEqual([]);
  });

  it("bounds what a lead can claim to have", () => {
    const many = Array.from({ length: 40 }, () => ({ category: "LC-MS", model: "5000", count: 5000 }));
    const back = parseSystems(JSON.stringify(many));
    expect(back).toHaveLength(20);
    expect(back[0].count).toBe(999);
    expect(parseSystems('[{"model":"5000","count":0}]')[0].count).toBe(1);
  });
});

describe("the blurb, which is published", () => {
  it("catches a finder who names the lab in the box every shop reads", () => {
    /*
     * The same hole a share's covering note left, from the other end. "Who
     * they are" is held back by construction - it is not in the object a shop
     * receives - and then the finder types the name into the field next to it.
     */
    expect(blurbLeaks("XYZ Biosciences need PM on four 5000s", LEAD))
      .toContain("XYZ Biosciences");
    expect(blurbLeaks("Two labs, no PM cover since their FSE left.", LEAD)).toEqual([]);
  });

  it("catches the person, the number and the door as well as the company", () => {
    expect(blurbLeaks("ask for Dr. P. Osei", LEAD)).toContain("Dr. P. Osei");
    expect(blurbLeaks("they answer on 555-0142", LEAD)).toContain("555-0142");
    expect(blurbLeaks("write to posei@xyzbio.test", LEAD)).toContain("posei@xyzbio.test");
    expect(blurbLeaks("the place on 44 Kendall St", LEAD)).toContain("44 Kendall St");
  });

  it("does not care how it was capitalized", () => {
    expect(blurbLeaks("xyz biosciences, four quads", LEAD)).toContain("XYZ Biosciences");
  });

  it("leaves the equipment and the region alone - that is the whole listing", () => {
    // A blurb has to be able to say what the work is, or nobody can price it.
    expect(blurbLeaks("4 × API 5000 in Boston metro, wants a PM contract", LEAD)).toEqual([]);
  });
});
