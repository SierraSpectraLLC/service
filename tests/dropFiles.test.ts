import { describe, expect, it } from "vitest";
import { isFileDrag, rejectedMessage, splitDropped } from "@/lib/dropFiles";

const f = (name: string, type = "") => ({ name, type });

describe("what somebody dragged in", () => {
  it("takes a PDF by its type or by its name", () => {
    // Explorer often hands over no MIME type at all, so the extension has to be
    // enough on its own.
    const { pdfs } = splitDropped([f("tune.pdf", "application/pdf"), f("report.PDF"), f("packet.pdf")]);
    expect(pdfs.map((p) => p.name)).toEqual(["tune.pdf", "report.PDF", "packet.pdf"]);
  });

  it("keeps the PDFs out of a mixed drop and names what it skipped", () => {
    const { pdfs, rejected } = splitDropped([
      f("bench.jpg", "image/jpeg"), f("tune.pdf", "application/pdf"), f("Q3 folder"),
    ]);
    expect(pdfs.map((p) => p.name)).toEqual(["tune.pdf"]);
    expect(rejected).toEqual(["bench.jpg", "Q3 folder"]);
  });

  it("does not take a PDF's word for it when the name disagrees", () => {
    expect(splitDropped([f("notes.txt", "text/plain")]).pdfs).toEqual([]);
  });

  it("has something to call an item with no name", () => {
    expect(splitDropped([f("", "")]).rejected).toEqual(["an unnamed item"]);
  });
});

describe("saying what was skipped", () => {
  it("says nothing when nothing was", () => {
    expect(rejectedMessage([])).toBe("");
  });

  it("names a few and counts the rest", () => {
    expect(rejectedMessage(["a.jpg"])).toBe("Only PDFs can be added here - skipped a.jpg.");
    expect(rejectedMessage(["a.jpg", "b.png", "c.doc", "d.xls", "e.txt"]))
      .toBe("Only PDFs can be added here - skipped a.jpg, b.png, c.doc and 2 more.");
  });
});

describe("telling a file drag from a page being reordered", () => {
  it("only counts a drag carrying files from outside the page", () => {
    expect(isFileDrag(["Files"])).toBe(true);
    expect(isFileDrag(["Files", "text/plain"])).toBe(true);
    // Dragging a page tile inside the working set must not light up the drop zone.
    expect(isFileDrag(["text/plain"])).toBe(false);
    expect(isFileDrag([])).toBe(false);
    expect(isFileDrag(undefined)).toBe(false);
  });
});
