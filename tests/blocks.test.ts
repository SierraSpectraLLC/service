import { describe, expect, it } from "vitest";
import {
  blockHolderName, blockLabel, blockOrgChoices, blockOrgId, blockSide,
} from "@/lib/blocks";

/**
 * Whose block is it.
 *
 * The trap this file guards is the one the whole feature exists to close, and
 * it is easy to reintroduce because it reads as common sense: "the reason says
 * we are waiting on LabZen, so the block is LabZen's". It is not. The machine
 * is on our bench and the chase is ours; a block parked on a customer is a
 * block nobody here looks at again.
 */

/* Sierra Spectra is 3. Lab Zen, its client, is 5. */
const OPERATOR = 3;
const CLIENT = 5;
const name = (id: number | null) =>
  id === 3 ? "Sierra Spectra" : id === 5 ? "Lab Zen" : id === 9 ? "Coastal Analytical" : "";

describe("what a block with no organization on it means", () => {
  it("reads as the operator's, which is what every older row is", () => {
    // The column arrived after thousands of blocks were recorded, and lib/digest
    // courted every one of them to "us". Null has to keep saying exactly that,
    // or a year of ordinary bench blocks turns into a year of missing data.
    expect(blockOrgId(null, OPERATOR)).toBe(OPERATOR);
    expect(blockSide(null, CLIENT, OPERATOR)).toBe("us");
    expect(blockHolderName(null, OPERATOR, name)).toBe("");
  });
});

describe("the court a block lands in", () => {
  it("stays with us when we hold it, whoever we are waiting on", () => {
    // THE RULE. The reason is free text and may well name the client; the
    // court is decided by the recorded holder and nothing else.
    expect(blockSide(OPERATOR, CLIENT, OPERATOR)).toBe("us");
  });

  it("moves to the partner only when the block was put under them", () => {
    expect(blockSide(CLIENT, CLIENT, OPERATOR)).toBe("partner");
  });

  it("does not move to a partner it was not put under", () => {
    // A block held by a third party - a reseller the unit is shared with -
    // is not this engagement's to answer for. It stays ours to chase here.
    expect(blockSide(9, CLIENT, OPERATOR)).toBe("us");
  });

  it("is always ours in the section for our own bench", () => {
    // The house's own section has no partner to hand anything to, so even a
    // block recorded against an organization courts to us there.
    expect(blockSide(CLIENT, null, OPERATOR)).toBe("us");
  });
});

describe("naming the holder", () => {
  it("says nothing where the answer is the operator reading it", () => {
    // "Blocked with Sierra Spectra" on a Sierra Spectra screen is the shop's
    // name used as a frame rather than as an answer - the same thing the
    // coverage summary had to stop doing.
    expect(blockHolderName(OPERATOR, OPERATOR, name)).toBe("");
    expect(blockLabel(blockHolderName(OPERATOR, OPERATOR, name))).toBe("Blocked");
  });

  it("names anybody else", () => {
    expect(blockHolderName(CLIENT, OPERATOR, name)).toBe("Lab Zen");
    expect(blockLabel("Lab Zen")).toBe("Blocked with Lab Zen");
  });

  it("never says blocked BY", () => {
    // A block is a state, not an accusation, and most of them are nobody's
    // fault. "with" is the queue's word for possession and it is the right
    // one here too.
    expect(blockLabel("Coastal Analytical")).not.toMatch(/by/i);
  });
});

describe("who may be offered", () => {
  const parties = [
    { id: OPERATOR, name: "Sierra Spectra", note: "working it" },
    { id: CLIENT, name: "Lab Zen", note: "owns it" },
    { id: 9, name: "Coastal Analytical", note: "shared with" },
  ];

  it("puts the asker's own organization first, because it is the default", () => {
    expect(blockOrgChoices(parties, CLIENT).map((c) => c.id)).toEqual([CLIENT, OPERATOR, 9]);
    expect(blockOrgChoices(parties, OPERATOR).map((c) => c.id)).toEqual([OPERATOR, CLIENT, 9]);
  });

  it("keeps the given order when the asker belongs to none of them", () => {
    expect(blockOrgChoices(parties, null).map((c) => c.id)).toEqual([OPERATOR, CLIENT, 9]);
  });

  it("lists an organization once even when it is two of the parties", () => {
    // A shop that owns the machine it is working is both "working it" and
    // "owns it"; the picker must not show Sierra Spectra twice.
    const dupe = [
      { id: OPERATOR, name: "Sierra Spectra", note: "working it" },
      { id: OPERATOR, name: "Sierra Spectra", note: "owns it" },
      { id: CLIENT, name: "Lab Zen", note: "shared with" },
    ];
    expect(blockOrgChoices(dupe, OPERATOR).map((c) => c.id)).toEqual([OPERATOR, CLIENT]);
    expect(blockOrgChoices(dupe, OPERATOR)[0].note).toBe("working it");
  });

  it("carries the note that says why each one is on the list", () => {
    // Two of the three can be the same kind of company and the names alone do
    // not tell you which one owns the machine.
    expect(blockOrgChoices(parties, OPERATOR).map((c) => c.note))
      .toEqual(["working it", "owns it", "shared with"]);
  });
});
