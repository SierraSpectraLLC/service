import { describe, expect, it } from "vitest";
import { MB, UNLIMITED, fits, fmtBytes, quotaFor, quotaLabel, overQuotaMessage } from "@/lib/storage";

describe("quotaFor", () => {
  it("reports an unlimited store as unlimited, not as 0% of nothing", () => {
    const q = quotaFor(900 * MB, UNLIMITED);
    expect(q.state).toBe("unlimited");
    expect(q.limitBytes).toBeNull();
    expect(q.remainingBytes).toBeNull();
    expect(q.pct).toBe(0);
  });

  it("computes percentage and remainder against the ceiling", () => {
    const q = quotaFor(512 * MB, 1024);
    expect(q.pct).toBe(50);
    expect(q.remainingBytes).toBe(512 * MB);
    expect(q.state).toBe("ok");
  });

  it("warns before the wall, not at it", () => {
    // A shop that only learns about the limit from a failed upload has been
    // told too late; 85% is the nudge.
    expect(quotaFor(840 * MB, 1024).state).toBe("ok");
    expect(quotaFor(880 * MB, 1024).state).toBe("warn");
    expect(quotaFor(1024 * MB, 1024).state).toBe("full");
  });

  it("clamps an over-quota store instead of reporting negative space", () => {
    const q = quotaFor(2048 * MB, 1024);
    expect(q.pct).toBe(100);
    expect(q.remainingBytes).toBe(0);
    expect(q.state).toBe("full");
  });

  it("treats a negative or absurd usage as zero rather than propagating it", () => {
    expect(quotaFor(-5, 1024).usedBytes).toBe(0);
  });
});

describe("fits", () => {
  it("always fits when there is no ceiling", () => {
    expect(fits(9e12, 9e12, UNLIMITED)).toBe(true);
  });

  it("allows an upload that lands exactly on the limit", () => {
    expect(fits(900 * MB, 124 * MB, 1024)).toBe(true);
  });

  it("refuses the byte that would cross it", () => {
    expect(fits(900 * MB, 125 * MB, 1024)).toBe(false);
  });

  it("refuses anything at all once full", () => {
    expect(fits(1024 * MB, 1, 1024)).toBe(false);
  });
});

describe("fmtBytes", () => {
  it("scales the unit to the size", () => {
    expect(fmtBytes(0)).toBe("0 B");
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(2048)).toBe("2 KB");
    expect(fmtBytes(3.4 * MB)).toBe("3.4 MB");
    expect(fmtBytes(1.25 * 1024 * MB)).toBe("1.25 GB");
  });

  it("never prints NaN or a negative size", () => {
    expect(fmtBytes(NaN)).toBe("0 B");
    expect(fmtBytes(-1)).toBe("0 B");
  });
});

describe("the copy a person actually reads", () => {
  it("names the ceiling when there is one", () => {
    expect(quotaLabel(quotaFor(3.4 * MB, 1024))).toBe("3.4 MB of 1.00 GB");
  });

  it("says so when there isn't", () => {
    expect(quotaLabel(quotaFor(3.4 * MB, UNLIMITED))).toBe("3.4 MB stored (no limit)");
  });

  it("a refusal names the shortfall, so it can be acted on", () => {
    const msg = overQuotaMessage("LabZen", quotaFor(1020 * MB, 1024), 10 * MB);
    expect(msg).toContain("LabZen is out of file storage");
    expect(msg).toContain("10.0 MB more");
    expect(msg).toMatch(/6\.0 MB over/);
    expect(msg).toContain("Settings");
  });
});
