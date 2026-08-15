import { describe, it, expect } from "vitest";
import { stageChange, autoFg, partOpen, gasAttention, trackUrl } from "@/lib/stages";

describe("autoFg", () => {
  it("returns a dark shade for light backgrounds", () => {
    // #F4CCCC -> each channel * 0.42, rounded: 244->102 (66), 204->86 (56)
    expect(autoFg("#F4CCCC")).toBe("#665656");
  });
  it("returns a pale tint for dark backgrounds", () => {
    const fg = autoFg("#38761D");
    const n = parseInt(fg.slice(1), 16);
    const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    expect(lum).toBeGreaterThan(180);
  });
  it("accepts bare hex without the hash", () => {
    expect(autoFg("F4CCCC")).toBe("#665656");
  });
  it("falls back to slate for garbage input", () => {
    expect(autoFg("red")).toBe("#475569");
    expect(autoFg("#12")).toBe("#475569");
  });
});

describe("partOpen", () => {
  it("treats Received / Installed / Removed as closed", () => {
    for (const s of ["Received", "Installed", "Removed"]) expect(partOpen(s)).toBe(false);
  });
  it("treats the rest as open", () => {
    for (const s of ["Needed", "Ordered", "In transit", "Backordered"]) expect(partOpen(s)).toBe(true);
  });
});

describe("gasAttention", () => {
  it("flags Low, Empty and Not connected", () => {
    for (const s of ["Low", "Empty", "Not connected"]) expect(gasAttention(s)).toBe(true);
  });
  it("never flags Connected or Not needed", () => {
    expect(gasAttention("Connected")).toBe(false);
    expect(gasAttention("Not needed")).toBe(false);
  });
});

describe("trackUrl", () => {
  it("builds carrier links and strips whitespace from tracking numbers", () => {
    expect(trackUrl("UPS", "1Z 999")).toBe("https://www.ups.com/track?tracknum=1Z999");
    expect(trackUrl("FedEx", "12")).toContain("fedex.com");
  });
  it("returns null without a number or for unlinkable carriers", () => {
    expect(trackUrl("UPS", "")).toBeNull();
    expect(trackUrl("Freight", "99")).toBeNull();
  });
});

describe("putting a stage on and taking it off", () => {
  const KNOWN = ["Intake", "Checkout", "Shipped"];

  it("only adds a stage the workspace has defined", () => {
    expect(stageChange(["Intake"], "Checkout", KNOWN)).toEqual({ ok: true, next: ["Intake", "Checkout"] });
    const bad = stageChange(["Intake"], "Chekout", KNOWN);
    expect(bad.ok).toBe(false);
    // The rule that stops one stage existing under four spellings.
    if (!bad.ok) expect(bad.error).toContain("Chekout");
  });

  it("always lets go of a stage the record already carries", () => {
    // The bug this closes: "Maintenance due" is put on a system by code - a
    // client reports a fault, a PM falls due - and it was added to the built-in
    // list long after the stage table was seeded. So it sat on systems while
    // being absent from the vocabulary, and taking it off threw "Unknown stage".
    expect(stageChange(["In service", "Maintenance due"], "Maintenance due", KNOWN))
      .toEqual({ ok: true, next: ["In service"] });
  });

  it("keeps a system on at least one stage", () => {
    const only = stageChange(["Intake"], "Intake", KNOWN);
    expect(only.ok).toBe(false);
    if (!only.ok) expect(only.error).toContain("at least one");
  });

  it("says so in words rather than throwing", () => {
    // Thrown errors in a server action reach the browser as a digest crash page,
    // which is what a customer saw for this.
    for (const r of [stageChange(["Intake"], "Nope", KNOWN), stageChange(["Intake"], "Intake", KNOWN)]) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(10);
    }
  });
});
