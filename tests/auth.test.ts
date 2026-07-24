import { describe, it, expect, beforeEach } from "vitest";
import { parseList, matchesEntry, roleForEmail } from "@/lib/allowMatch";

describe("parseList", () => {
  it("splits, trims, lowercases and drops empties", () => {
    expect(parseList(" A@x.com, b@y.com ,, ")).toEqual(["a@x.com", "b@y.com"]);
    expect(parseList(undefined)).toEqual([]);
  });
});

describe("matchesEntry", () => {
  it("matches exact emails", () => {
    expect(matchesEntry("jane@labzenllc.com", "jane@labzenllc.com")).toBe(true);
    expect(matchesEntry("jane@labzenllc.com", "raj@labzenllc.com")).toBe(false);
  });
  it("matches whole domains with @domain entries", () => {
    expect(matchesEntry("jane@labzenllc.com", "@labzenllc.com")).toBe(true);
    expect(matchesEntry("jane@other.com", "@labzenllc.com")).toBe(false);
  });
});

describe("roleForEmail", () => {
  beforeEach(() => {
    process.env.STAFF_EMAILS = "joe@sierra.com, bill@sierra.com";
    process.env.CLIENT_EMAILS = "jane@labzenllc.com, @clientdomain.com";
  });
  it("makes the first staff email the owner", () => {
    expect(roleForEmail("joe@sierra.com")).toBe("owner");
    expect(roleForEmail("JOE@SIERRA.COM")).toBe("owner");
  });
  it("makes other staff emails staff", () => {
    expect(roleForEmail("bill@sierra.com")).toBe("staff");
  });
  it("matches clients by email or domain entry", () => {
    expect(roleForEmail("jane@labzenllc.com")).toBe("client_viewer");
    expect(roleForEmail("anyone@clientdomain.com")).toBe("client_viewer");
  });
  it("never domain-matches staff and rejects unknowns", () => {
    expect(roleForEmail("intruder@sierra.com")).toBeNull();
    expect(roleForEmail("stranger@nowhere.com")).toBeNull();
  });
});
