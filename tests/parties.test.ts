import { describe, expect, it } from "vitest";
import { partyChoices } from "@/lib/parties";

/**
 * The organizations with a real hold on one system.
 *
 * Shared by two features that ask the same question - whose block is this
 * (lib/blocks) and who is making this part (lib/stages) - and both have the
 * same wrong answer available: every organization on the instance. A picker
 * built on that lets a block be parked, or a part attributed, to a company
 * with no connection to the machine, and on a multi-operator instance it hands
 * one shop its competitor's client book.
 */

/* Sierra Spectra is 3. Lab Zen, its client, is 5. Coastal is 9. */
const OPERATOR = 3;
const CLIENT = 5;

describe("who may be offered", () => {
  const parties = [
    { id: OPERATOR, name: "Sierra Spectra", note: "working it" },
    { id: CLIENT, name: "Lab Zen", note: "owns it" },
    { id: 9, name: "Coastal Analytical", note: "shared with" },
  ];

  it("puts the asker's own organization first, because it is the default", () => {
    expect(partyChoices(parties, CLIENT).map((c) => c.id)).toEqual([CLIENT, OPERATOR, 9]);
    expect(partyChoices(parties, OPERATOR).map((c) => c.id)).toEqual([OPERATOR, CLIENT, 9]);
  });

  it("keeps the given order when the asker belongs to none of them", () => {
    expect(partyChoices(parties, null).map((c) => c.id)).toEqual([OPERATOR, CLIENT, 9]);
  });

  it("lists an organization once even when it is two of the parties", () => {
    // A shop that owns the machine it is working is both "working it" and
    // "owns it"; the picker must not show Sierra Spectra twice.
    const dupe = [
      { id: OPERATOR, name: "Sierra Spectra", note: "working it" },
      { id: OPERATOR, name: "Sierra Spectra", note: "owns it" },
      { id: CLIENT, name: "Lab Zen", note: "shared with" },
    ];
    expect(partyChoices(dupe, OPERATOR).map((c) => c.id)).toEqual([OPERATOR, CLIENT]);
    expect(partyChoices(dupe, OPERATOR)[0].note).toBe("working it");
  });

  it("carries the note that says why each one is on the list", () => {
    // Two of the three can be the same kind of company and the names alone do
    // not tell you which one owns the machine.
    expect(partyChoices(parties, OPERATOR).map((c) => c.note))
      .toEqual(["working it", "owns it", "shared with"]);
  });
});
