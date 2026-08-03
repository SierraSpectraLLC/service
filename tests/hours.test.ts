import { describe, it, expect } from "vitest";
import { parseHours, formatHours } from "@/lib/hours";

describe("parseHours", () => {
  it("accepts decimal hours, with or without h", () => {
    expect(parseHours("1.5")).toBe(90);
    expect(parseHours("2h")).toBe(120);
    expect(parseHours(" 0.25 ")).toBe(15);
  });
  it("accepts h:mm and explicit minutes", () => {
    expect(parseHours("1:30")).toBe(90);
    expect(parseHours("45m")).toBe(45);
    expect(parseHours("45min")).toBe(45);
  });
  it("rejects junk and blanks", () => {
    expect(parseHours("")).toBeNull();
    expect(parseHours("a while")).toBeNull();
    expect(parseHours("1:75")).toBeNull();
  });
});

describe("formatHours", () => {
  it("renders whole and partial hours", () => {
    expect(formatHours(90)).toBe("1.5 h");
    expect(formatHours(120)).toBe("2 h");
    expect(formatHours(0)).toBe("0 h");
  });
});
