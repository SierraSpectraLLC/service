import { describe, expect, it } from "vitest";
import { renderDigestBody, type DigestSection } from "@/lib/digest";

/**
 * Each person writes their own EOD line, and the digest says whose each is.
 * The record's own lines - a task done, an order closed - carry no byline,
 * because nobody wrote them.
 */
const section: DigestSection = {
  orgId: 7, name: "Lab Zen",
  board: [], pending: [], followUps: [], handoffs: [], gas: [], failedTests: [],
  work: [{
    externalId: "O-004", label: "Waters Quattro micro",
    lines: [
      { text: "MassLynx reloaded; Empower comms restored", internal: false, by: "Bill Harner" },
      { text: "Next: verify methods against the acquisition PC", internal: false, by: "Bill Harner" },
      { text: "Source cleaned, cone replaced", internal: false, by: "Joe Harris" },
      { text: "Completed: Flow Check - Pass", internal: false },
    ],
  }],
  offSystem: [{ text: "Phone support - tune report question (Bill Harner · 30 min)", internal: false }],
  activity: "",
};

describe("the digest says whose line is whose", () => {
  it("puts a byline after each person's own words, and none on the record's", () => {
    const html = renderDigestBody([section], true, "Sierra Spectra");
    expect(html).toContain("MassLynx reloaded; Empower comms restored</div>".replace("</div>", "")); // the words
    expect(html).toMatch(/MassLynx reloaded; Empower comms restored\s*<span[^>]*>· Bill Harner<\/span>/);
    expect(html).toMatch(/Source cleaned, cone replaced\s*<span[^>]*>· Joe Harris<\/span>/);
    expect(html).not.toMatch(/Completed: Flow Check - Pass\s*<span/);
  });

  it("carries a logged call by its title and who took it", () => {
    const html = renderDigestBody([section], true, "Sierra Spectra");
    expect(html).toContain("Off the bench");
    expect(html).toContain("Phone support - tune report question (Bill Harner · 30 min)");
  });

  it("keeps the bylines on the client's copy too - they are the names on their report", () => {
    const html = renderDigestBody([section], false, "Sierra Spectra");
    expect(html).toContain("· Bill Harner");
  });
});
