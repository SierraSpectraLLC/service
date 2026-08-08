import { describe, expect, it } from "vitest";
import { normalizeSerial, serialSearchable } from "@/lib/serial";

describe("serial lookup rules", () => {
  it("normalizes case and surrounding whitespace only", () => {
    expect(normalizeSerial("  L2050 500 ")).toBe("l2050 500"); // inner spaces are part of the key
    expect(normalizeSerial("ABC123")).toBe("abc123");
  });

  it("refuses short strings - lookup is a key, not a scan", () => {
    expect(serialSearchable("")).toBe(false);
    expect(serialSearchable("a1")).toBe(false);
    expect(serialSearchable("  ab3  ")).toBe(false);
    expect(serialSearchable("ab34")).toBe(true);
  });
});
