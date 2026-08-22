// The failed-tests card: a recorded Fail is the sharpest line in the digest,
// worded for each edition, counted in the rollup, and gone the morning a
// re-run passes (the result row is replaced, so absence IS the clearing).
import { describe, expect, it } from "vitest";
import { digestCounts, renderDigestBody, type DigestSection } from "@/lib/digest";
import { TONE_HEX } from "@/lib/tones";

const section = (over: Partial<DigestSection> = {}): DigestSection => ({
  orgId: 7, name: "LabZen",
  board: [{ externalId: "LZ-11", label: "LC-2040C", stages: [], gases: [], openParts: 0, lead: "", notes: "" }],
  pending: [], followUps: [], handoffs: [], gas: [],
  failedTests: [], work: [], activity: "",
  ...over,
});

const failed = { externalId: "LZ-11", title: "Flow Check", value: "1.2 mL/min", days: 2, required: true };

describe("failed tests in the digest", () => {
  it("renders the card with the verdict, the age, and the sign-off consequence", () => {
    const html = renderDigestBody([section({ failedTests: [failed] })], true, "Sierra Spectra");
    expect(html).toContain("Failed tests (1)");
    expect(html).toContain("Flow Check: 1.2 mL/min");
    expect(html).toContain("blocks sign-off");
    expect(html).toContain("· 2d");
    expect(html).toContain(TONE_HEX.bad.fg);
  });

  it("words the partner edition factually, without the internal framing", () => {
    const html = renderDigestBody([section({ failedTests: [{ ...failed, required: false }] })], false, "Sierra Spectra");
    expect(html).toContain("Recorded results outside their pass limits.");
    expect(html).not.toContain("blocks sign-off");
  });

  it("a failed test forfeits the quiet line and lands in the counts", () => {
    const busy = renderDigestBody([section({ failedTests: [failed] })], true, "Sierra Spectra");
    expect(busy).not.toContain("every system is moving");
    const quiet = renderDigestBody([section()], true, "Sierra Spectra");
    expect(quiet).toContain("every system is moving");
    expect(digestCounts([section({ failedTests: [failed] })]).failed).toBe(1);
    expect(digestCounts([section()]).failed).toBe(0);
  });
});
