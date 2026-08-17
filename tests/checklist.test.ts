import { describe, expect, it } from "vitest";
import {
  checklistProgress, cleanItem, MAX_CHECKLIST_ITEMS, parseChecklist, serializeChecklist,
} from "@/lib/checklist";

// Typed exactly as somebody would off a TOC-Vw PPM sheet.
const TYPED = `Remove & Sonicate:
[] Low-Pressure Funnel Assembly
[] High-Pressure Funnel Assembly
Replace:
- Sample needle`;

describe("reading a typed checklist", () => {
  it("makes boxes of the lines and labels of the colons", () => {
    expect(parseChecklist(TYPED)).toEqual([
      { text: "Remove & Sonicate:", heading: true },
      { text: "Low-Pressure Funnel Assembly", heading: false },
      { text: "High-Pressure Funnel Assembly", heading: false },
      { text: "Replace:", heading: true },
      { text: "Sample needle", heading: false },
    ]);
  });

  it("strips whatever bullet it was pasted with", () => {
    expect(parseChecklist("- one\n* two\n1. three\n[] four\n[x] five\n• six").map((l) => l.text))
      .toEqual(["one", "two", "three", "four", "five", "six"]);
  });

  it("drops blank lines and whitespace, and never throws", () => {
    expect(parseChecklist("")).toEqual([]);
    expect(parseChecklist("\n\n   \n")).toEqual([]);
    expect(parseChecklist("  spaced  ")).toEqual([{ text: "spaced", heading: false }]);
  });

  it("drops a heading with nothing under it", () => {
    // The colon convention must not be able to leave a section title labelling
    // an empty space on somebody's task.
    expect(parseChecklist("Remove & Sonicate:")).toEqual([]);
    expect(parseChecklist("Steps:\nDone stuff:")).toEqual([]);
    expect(parseChecklist("Steps:\nFirst\nTrailing:").map((l) => l.text))
      .toEqual(["Steps:", "First"]);
  });

  it("bounds the list and each line", () => {
    expect(parseChecklist(Array.from({ length: 200 }, (_, i) => `item ${i}`).join("\n")))
      .toHaveLength(MAX_CHECKLIST_ITEMS);
    expect(parseChecklist("x".repeat(500))[0].text).toHaveLength(200);
  });

  it("round-trips what was typed, minus the noise", () => {
    expect(serializeChecklist(parseChecklist(TYPED))).toBe(
      "Remove & Sonicate:\nLow-Pressure Funnel Assembly\nHigh-Pressure Funnel Assembly\nReplace:\nSample needle",
    );
  });
});

describe("how far through it is", () => {
  const items = [
    { text: "Remove & Sonicate:", heading: true, done: false },
    { text: "Low-Pressure", heading: false, done: true },
    { text: "High-Pressure", heading: false, done: true },
  ];

  it("never counts a heading as a box", () => {
    // Counting them reports a finished job as 2/3 forever, and nobody ever
    // finds the step they apparently missed.
    expect(checklistProgress(items)).toEqual({ done: 2, total: 2, complete: true });
  });

  it("an empty list is not a complete one", () => {
    expect(checklistProgress([])).toEqual({ done: 0, total: 0, complete: false });
    expect(checklistProgress([{ done: false, heading: true }]))
      .toEqual({ done: 0, total: 0, complete: false });
  });

  it("treats a missing heading flag as an ordinary box", () => {
    expect(checklistProgress([{ done: true }, { done: false }])).toEqual({ done: 1, total: 2, complete: false });
  });
});

describe("one item typed into the box", () => {
  it("takes a line, a heading, or nothing", () => {
    expect(cleanItem("  - Sonicate the funnel  ")).toEqual({ text: "Sonicate the funnel", heading: false });
    expect(cleanItem("Remove & Sonicate:")).toEqual({ text: "Remove & Sonicate:", heading: true });
    expect(cleanItem("   ")).toBeNull();
    expect(cleanItem("[]")).toBeNull();
  });
});
