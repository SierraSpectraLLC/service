import { describe, expect, it } from "vitest";
import {
  addDaysIso, cleanExpiry, cleanLabel, DEFAULT_LINK_DAYS, linkLabel, linkLine, linkState,
  linkUsable, MAX_LINK_DAYS,
} from "@/lib/dropShare";

const TODAY = "2026-08-18";

describe("whether a link works", () => {
  it("lives until the end of its last day", () => {
    expect(linkState({ expiresOn: "2026-08-18", revokedAt: null }, TODAY)).toBe("active");
    expect(linkState({ expiresOn: "2026-08-17", revokedAt: null }, TODAY)).toBe("expired");
    expect(linkUsable({ expiresOn: "2026-09-01", revokedAt: null }, TODAY)).toBe(true);
  });

  it("revoked beats expired - they call for different sentences", () => {
    expect(linkState({ expiresOn: "2026-01-01", revokedAt: new Date() }, TODAY)).toBe("revoked");
  });
});

describe("picking an expiry", () => {
  it("takes today through the cap, and nothing else", () => {
    expect(cleanExpiry(TODAY, TODAY)).toEqual({ expiresOn: TODAY });
    expect(cleanExpiry(addDaysIso(TODAY, MAX_LINK_DAYS), TODAY)).toEqual({ expiresOn: "2026-11-16" });
    expect("error" in cleanExpiry("2026-08-17", TODAY)).toBe(true);           // past
    expect("error" in cleanExpiry(addDaysIso(TODAY, 91), TODAY)).toBe(true);  // beyond the cap
    expect("error" in cleanExpiry("soon", TODAY)).toBe(true);
  });

  it("the default lands inside the cap", () => {
    expect(DEFAULT_LINK_DAYS).toBeLessThanOrEqual(MAX_LINK_DAYS);
    expect(addDaysIso(TODAY, DEFAULT_LINK_DAYS)).toBe("2026-09-01");
  });

  it("survives a month boundary", () => {
    expect(addDaysIso("2026-08-31", 1)).toBe("2026-09-01");
    expect(addDaysIso("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("how a link reads in a list", () => {
  it("names itself when nobody did", () => {
    expect(linkLabel({ label: " LabZen PC ", expiresOn: "2026-09-01" })).toBe("LabZen PC");
    expect(linkLabel({ label: "", expiresOn: "2026-09-01" })).toBe("Link until 2026-09-01");
  });

  it("counts down in days, the unit the decision is made in", () => {
    expect(linkLine({ expiresOn: "2026-08-19", revokedAt: null }, TODAY)).toBe("1 day left");
    expect(linkLine({ expiresOn: TODAY, revokedAt: null }, TODAY)).toBe("expires today");
    expect(linkLine({ expiresOn: "2026-08-01", revokedAt: null }, TODAY)).toBe("expired 2026-08-01");
    expect(linkLine({ expiresOn: "2026-08-01", revokedAt: new Date() }, TODAY)).toBe("revoked");
  });

  it("keeps a label a label", () => {
    expect(cleanLabel("  a   b  ")).toBe("a b");
    expect(cleanLabel("x".repeat(200))).toHaveLength(80);
  });
});
