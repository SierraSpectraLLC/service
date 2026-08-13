import { describe, expect, it } from "vitest";
import { cleanNickname, deviceLabel, deviceSubLabel, needsNickname } from "@/lib/deviceName";

describe("what to call a machine", () => {
  it("uses the name a person gave it", () => {
    expect(deviceLabel("Altis PC", "DESKTOP-39VTF39")).toBe("Altis PC");
  });

  it("falls back to the hostname, then to something rather than nothing", () => {
    expect(deviceLabel("", "DESKTOP-39VTF39")).toBe("DESKTOP-39VTF39");
    expect(deviceLabel("  ", "  ")).toBe("Unnamed machine");
  });

  it("keeps the hostname visible beside a nickname, never instead of it", () => {
    // The nickname is for finding the machine; the hostname is for proving it is
    // the right one. Replacing the second with the first loses that.
    expect(deviceSubLabel("Altis PC", "DESKTOP-39VTF39")).toBe("DESKTOP-39VTF39");
    expect(deviceSubLabel("", "DESKTOP-39VTF39")).toBe("");   // already the label
    expect(deviceSubLabel("Altis PC", "")).toBe("");
  });
});

describe("nudging toward a real name", () => {
  it("spots the names Windows makes up", () => {
    for (const h of ["DESKTOP-39VTF39", "LAPTOP-8H2K1A", "WIN-4890DFJKL", "desktop-abc123"]) {
      expect(needsNickname("", h)).toBe(true);
    }
  });

  it("leaves a machine somebody already named alone", () => {
    expect(needsNickname("Altis PC", "DESKTOP-39VTF39")).toBe(false);
    expect(needsNickname("", "ALTIS-TUNE-01")).toBe(false);
    expect(needsNickname("", "LCMS2")).toBe(false);
    expect(needsNickname("", "")).toBe(false);
  });
});

describe("cleaning what somebody typed", () => {
  it("collapses whitespace and bounds the length", () => {
    expect(cleanNickname("  Altis   PC  ")).toBe("Altis PC");
    expect(cleanNickname("x".repeat(200))).toHaveLength(60);
  });

  it("treats an emptied box as clearing the nickname", () => {
    expect(cleanNickname("   ")).toBe("");
  });
});
