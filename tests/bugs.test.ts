// Reporting something the machine did not notice.
//
// The trail catches exceptions. It cannot catch a total that is wrong, and
// that is most of what goes wrong with software people use all day. So these
// hold down the rules that decide whether a report is worth anything: that it
// carries where somebody was, that ending one costs a sentence, and that a
// blocker outranks an annoyance.
import { describe, expect, it } from "vitest";
import {
  browserLine, needsResolution, parseCrumbs, rankReports, reportOpen,
  reportProblems, serializeCrumbs, whereLine, MAX_BREADCRUMBS, type Breadcrumb,
} from "@/lib/bugs";

describe("what a report has to have", () => {
  it("accepts one sentence and nothing else", () => {
    // The body is optional on purpose: somebody who has just watched a total
    // come out wrong types one line. Demanding a second is how a report
    // becomes a report nobody files.
    expect(reportProblems({ title: "The invoice total is short", kind: "bug" })).toEqual([]);
  });

  it("refuses a title too short to mean anything", () => {
    expect(reportProblems({ title: "bad", kind: "bug" })[0]).toContain("in a line");
    expect(reportProblems({ title: "   ", kind: "bug" })[0]).toContain("in a line");
  });

  it("refuses a kind that is not one", () => {
    expect(reportProblems({ title: "Something is off", kind: "rant" })[0]).toContain("what kind");
  });
});

describe("where they were, which nobody types", () => {
  it("puts the route, the window and the build on one line", () => {
    expect(whereLine({
      route: "/money/invoices/12", query: "tab=lines", viewport: "1400x900",
      buildSha: "9f2c1ab3c4d5e6",
    })).toBe("/money/invoices/12?tab=lines · 1400x900 · build 9f2c1ab");
  });

  it("leaves out what it does not have rather than printing gaps", () => {
    expect(whereLine({ route: "/work", query: "", viewport: "", buildSha: "" })).toBe("/work");
  });

  it("names the browser in the two words that decide reproducibility", () => {
    const chrome = "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120.0 Safari/537.36";
    expect(browserLine(chrome)).toBe("Chrome");
    expect(browserLine("Mozilla/5.0 (iPhone) AppleWebKit Version/17.0 Mobile/15E148 Safari/604.1"))
      .toBe("Safari on a phone");
    // Edge and Opera both claim to be Chrome; the more specific match wins.
    expect(browserLine("Mozilla/5.0 Chrome/120.0 Safari/537.36 Edg/120.0")).toBe("Edge");
    expect(browserLine("")).toBe("");
  });
});

describe("the breadcrumbs", () => {
  const crumb = (over: Partial<Breadcrumb> = {}): Breadcrumb => ({
    at: "2026-08-28T14:02:00.000Z", kind: "page", route: "/work", message: "", ...over,
  });

  it("round-trips", () => {
    const rows = [crumb(), crumb({ kind: "error", message: "Cannot read x" })];
    expect(parseCrumbs(serializeCrumbs(rows))).toEqual(rows);
    expect(serializeCrumbs([])).toBe("");
  });

  it("treats rubbish as none rather than taking the queue down", () => {
    // This column renders on every row of the list; one bad report must not
    // cost the reader the other twenty.
    expect(parseCrumbs("")).toEqual([]);
    expect(parseCrumbs("not json")).toEqual([]);
    expect(parseCrumbs('{"route":"/work"}')).toEqual([]);
    expect(parseCrumbs("[null, 7]")).toEqual([]);
  });

  it("is bounded on the way in and on the way out", () => {
    const many = Array.from({ length: 40 }, () => crumb());
    expect(parseCrumbs(serializeCrumbs(many))).toHaveLength(MAX_BREADCRUMBS);
    expect(parseCrumbs(JSON.stringify(many))).toHaveLength(MAX_BREADCRUMBS);
  });
});

describe("driving one to an end", () => {
  it("knows which are still somebody's to answer", () => {
    expect(reportOpen("new")).toBe(true);
    expect(reportOpen("open")).toBe(true);
    expect(reportOpen("fixed")).toBe(false);
    expect(reportOpen("closed")).toBe(false);
  });

  it("costs a sentence to END one, and nothing to pick it up", () => {
    /*
     * The rule that keeps this from being a suggestion box. "Closed" with no
     * word beside it is how the person who filed it learns not to bother
     * again, and the report after the one they stopped filing is the one that
     * mattered.
     */
    expect(needsResolution("fixed")).toBe(true);
    expect(needsResolution("closed")).toBe(true);
    expect(needsResolution("open")).toBe(false);
    expect(needsResolution("new")).toBe(false);
  });
});

describe("what the list puts first", () => {
  const row = (id: number, status: string, blocking = false) => ({ id, status, blocking });

  it("puts somebody who cannot work above somebody who is annoyed", () => {
    const ranked = rankReports([
      row(1, "new"), row(2, "new", true), row(3, "fixed"), row(4, "open", true),
    ]);
    expect(ranked.map((r) => r.id)).toEqual([4, 2, 1, 3]);
  });

  it("keeps settled rows out of the way without hiding them", () => {
    // A closed report is still evidence - somebody about to file the same one
    // needs to find the answer - so it sorts last rather than disappearing.
    const ranked = rankReports([row(1, "closed"), row(2, "new")]);
    expect(ranked.map((r) => r.id)).toEqual([2, 1]);
  });

  it("is newest-first inside a band", () => {
    const ranked = rankReports([row(7, "new"), row(9, "new"), row(8, "new")]);
    expect(ranked.map((r) => r.id)).toEqual([9, 8, 7]);
  });
});
