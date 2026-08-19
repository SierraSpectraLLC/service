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
