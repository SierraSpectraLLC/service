// The EOD narrative in the digest, both editions.
//
// The engineer writes a real end-of-day - "MassLynx reloaded, Empower comms
// restored, next: verify against the acquisition PC" - and until this existed
// the client's edition compressed that whole day to a stage pill and a
// username. These tests pin the fix: the narrative reaches the partner
// edition under the system it belongs to, lines the engineer marked
// house-only never do, and a day spent entirely off the bench (the phone
// call, the walkthrough) still reads as a day.
import { describe, expect, it } from "vitest";
import { renderDigestBody, type DigestSection } from "@/lib/digest";
import {
  MAX_NOTES, partnerPreheader, partnerView, renderPartnerDigest, renderPartnerDigestText,
} from "@/lib/digestPartner";
import { TONE_HEX } from "@/lib/tones";

const board = [{
  externalId: "O-004", label: "Waters Quattro micro", stages: ["Refurbishment"],
  gases: [], openParts: 0, lead: "joe.vincent",
}];

const work = [{
  externalId: "O-004", label: "Waters Quattro micro",
  lines: [
    { text: "MassLynx reloaded; Empower comms restored", internal: false },
    { text: "Next: verify methods against the acquisition PC", internal: false },
    { text: "Quoted the rebuild high on purpose - margin room", internal: true },
  ],
}];

const offSystem = [
  { text: "Walked the new lab space with facilities", internal: false },
  { text: "Margin strategy call with the sales rep", internal: true },
];

const view = (over: Record<string, unknown> = {}) => partnerView({
  section: { name: "Wjharner", board, pending: [], handoffs: [], work, offSystem, ...over },
  operatorName: "Sierra Spectra",
  dateLabel: "Mon Aug 25",
  portalUrl: "https://service.example.com",
  blockedStage: "Waiting / blocked",
  gapDays: 1,
  stageHex: () => TONE_HEX.neutral,
  gasBlocking: () => false,
});

describe("the narrative reaches the partner edition", () => {
  const v = view();
  const html = renderPartnerDigest(v, partnerPreheader(v));
  const text = renderPartnerDigestText(v, partnerPreheader(v));

  it("hangs the client-safe lines under the system they belong to", () => {
    expect(v.inWork[0].notes).toEqual([
      "MassLynx reloaded; Empower comms restored",
      "Next: verify methods against the acquisition PC",
    ]);
    expect(html).toContain("MassLynx reloaded; Empower comms restored");
    expect(text).toContain("Next: verify methods against the acquisition PC");
  });

  it("never leaks a line the engineer marked house-only", () => {
    const both = `${html}\n${text}`;
    expect(both).not.toContain("Quoted the rebuild high");
    expect(both).not.toContain("Margin strategy call");
  });

  it("carries the off-system day as its own block", () => {
    expect(v.also).toEqual(["Walked the new lab space with facilities"]);
    expect(html).toContain("ALSO IN THIS WINDOW");
    expect(html).toContain("Walked the new lab space with facilities");
    expect(text).toContain("ALSO IN THIS WINDOW");
    expect(text).toContain("Walked the new lab space with facilities");
  });

  it("still filters the bookkeeping phrasing, flag or no flag", () => {
    // A pasted sheet-sync remark arrives with internal=false because nobody
    // ticked the box; the phrasing heuristic is the second gate.
    const leak = view({
      work: [{
        externalId: "O-004", label: "Waters Quattro micro",
        lines: [{ text: "No longer on the Google sheet - dropped from sync", internal: false }],
      }],
      offSystem: [],
    });
    const h = renderPartnerDigest(leak, partnerPreheader(leak));
    expect(h).not.toContain("Google sheet");
    expect(leak.inWork[0].notes).toEqual([]);
  });
});

describe("the size caps say what they dropped", () => {
  it("clips a long diary and counts the rest out loud", () => {
    const lines = Array.from({ length: MAX_NOTES + 3 }, (_, i) =>
      ({ text: `Day note number ${i + 1}`, internal: false }));
    const v = view({ work: [{ externalId: "O-004", label: "Waters Quattro micro", lines }], offSystem: [] });
    const notes = v.inWork[0].notes;
    expect(notes).toHaveLength(MAX_NOTES + 1);
    expect(notes[notes.length - 1]).toBe("...and 3 more in the portal.");
  });
});

describe("a client whose whole day was a phone call", () => {
  it("still gets an edition, and its inbox line is not a row of zeros", () => {
    const v = view({ board: [], work: [] });
    expect(v.inWork).toEqual([]);
    expect(v.also).toEqual(["Walked the new lab space with facilities"]);
    expect(partnerPreheader(v)).toBe("1 update from Sierra Spectra's day on your account");
    const html = renderPartnerDigest(v, partnerPreheader(v));
    expect(html).toContain("ALSO IN THIS WINDOW");
  });
});

describe("callers that predate the narrative", () => {
  it("renders exactly as before when no work or offSystem is handed in", () => {
    const v = view({ work: undefined, offSystem: undefined });
    expect(v.inWork[0].notes).toEqual([]);
    expect(v.also).toEqual([]);
    const html = renderPartnerDigest(v, partnerPreheader(v));
    expect(html).not.toContain("ALSO IN THIS WINDOW");
  });
});

describe("the internal edition sees everything", () => {
  const section: DigestSection = {
    orgId: 7, name: "Wjharner",
    board: board.map((b) => ({ ...b, notes: "" })),
    pending: [], followUps: [], handoffs: [], gas: [], failedTests: [],
    work: work as DigestSection["work"],
    offSystem: offSystem as DigestSection["offSystem"],
    activity: "",
  };

  it("keeps the house-only lines and the off-the-bench block", () => {
    const html = renderDigestBody([section], true, "Sierra Spectra");
    expect(html).toContain("Quoted the rebuild high on purpose - margin room");
    expect(html).toContain("Off the bench");
    expect(html).toContain("Margin strategy call with the sales rep");
  });

  it("drops them when the same body renders for the other side", () => {
    const html = renderDigestBody([section], false, "Sierra Spectra");
    expect(html).toContain("MassLynx reloaded; Empower comms restored");
    expect(html).not.toContain("Quoted the rebuild high");
    expect(html).not.toContain("Margin strategy call");
  });
});
