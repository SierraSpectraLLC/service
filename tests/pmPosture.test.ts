import { describe, expect, it } from "vitest";
import { isPmPosture, pmPosture, postureIsDefault, postureLine } from "../src/lib/pmPosture";

describe("pmPosture", () => {
  it("follows the owner when nothing is stored: resellers advisory, everyone else scheduled", () => {
    expect(pmPosture("", true)).toBe("advisory");
    expect(pmPosture("", false)).toBe("scheduled");
  });

  it("an explicit choice beats the owner's default in either direction", () => {
    // The reseller's own service arm puts one system back on a calendar...
    expect(pmPosture("scheduled", true)).toBe("scheduled");
    // ...and a service shop can park one long-term loaner as reference.
    expect(pmPosture("advisory", false)).toBe("advisory");
  });

  it("junk in the column falls back to the default rather than inventing a state", () => {
    expect(pmPosture("banana", true)).toBe("advisory");
    expect(pmPosture("banana", false)).toBe("scheduled");
  });

  it("unowned systems are scheduled - house stock keeps its calendar", () => {
    // The caller passes ownerResale=false for a null owner; the rule is here
    // so the intent is written down where it can fail a test.
    expect(pmPosture("", false)).toBe("scheduled");
  });
});

describe("postureIsDefault", () => {
  it("only the two real values count as an explicit choice", () => {
    expect(postureIsDefault("")).toBe(true);
    expect(postureIsDefault("scheduled")).toBe(false);
    expect(postureIsDefault("advisory")).toBe(false);
    expect(postureIsDefault("banana")).toBe(true);
  });
});

describe("isPmPosture", () => {
  it("accepts the storable values and nothing else", () => {
    expect(isPmPosture("")).toBe(true);
    expect(isPmPosture("scheduled")).toBe(true);
    expect(isPmPosture("advisory")).toBe(true);
    expect(isPmPosture("paused")).toBe(false);
  });
});

describe("postureLine", () => {
  it("says the answer came from the owner when it did", () => {
    expect(postureLine("", true, "FlipLab")).toContain("FlipLab");
    expect(postureLine("", true, "FlipLab")).toContain("reseller");
  });
  it("says the answer was set here when it was", () => {
    expect(postureLine("advisory", false, "GMI")).toContain("Set on this system");
    expect(postureLine("scheduled", true, "FlipLab")).toContain("Set on this system");
  });
});

describe("a system somebody else maintains", () => {
  /* A machine under contract with the manufacturer gets its PMs from the
     manufacturer. Generating tasks and moving the queue for visits we are not
     making puts overdue red on a calendar that was never ours to keep - and
     chases a client who is not late for anything. */

  it("goes advisory by default", () => {
    expect(pmPosture("", false, true)).toBe("advisory");
    expect(pmPosture("", false, false)).toBe("scheduled");
  });

  it("still loses to an explicit choice on the system", () => {
    // The escape hatch stays open in both directions: a shop that agrees to
    // cover one machine anyway says so on that machine.
    expect(pmPosture("scheduled", false, true)).toBe("scheduled");
    expect(pmPosture("advisory", false, false)).toBe("advisory");
  });

  it("says WHICH default is deciding, because the fix differs", () => {
    // Two defaults can land on advisory and they are facts about different
    // companies. Coverage is the more specific, so it wins the sentence.
    expect(postureLine("", false, "InterVenn", "Agilent")).toContain("Agilent");
    expect(postureLine("", false, "InterVenn", "Agilent")).not.toContain("reseller");
    expect(postureLine("", true, "FlipLab", "")).toContain("reseller");
  });

  it("keeps an explicit choice's sentence explicit", () => {
    expect(postureLine("scheduled", false, "InterVenn", "Agilent"))
      .toContain("Set on this system");
  });
});
