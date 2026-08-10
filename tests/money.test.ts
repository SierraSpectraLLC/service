import { describe, expect, it } from "vitest";
import { parseMoney, formatCents } from "@/lib/money";

describe("parseMoney", () => {
  it("accepts the shapes people actually type", () => {
    expect(parseMoney("1,240")).toBe(124000);
    expect(parseMoney("$95.50")).toBe(9550);
    expect(parseMoney("  $1,234.56 ")).toBe(123456);
    expect(parseMoney("0")).toBe(0);
    expect(parseMoney("12")).toBe(1200);
  });

  it("refuses to guess at anything ambiguous", () => {
    // Summing "$1.2k" as $1.20 would be worse than not summing it.
    for (const bad of ["", "call for quote", "$1.2k", "12.5.3", "1 240", "-50", "TBD"]) {
      expect(parseMoney(bad)).toBeNull();
    }
  });
});

describe("formatCents", () => {
  it("drops cents when they're zero, keeps them otherwise", () => {
    expect(formatCents(124000)).toBe("$1,240");
    expect(formatCents(9550)).toBe("$95.50");
    expect(formatCents(0)).toBe("$0");
  });
});
