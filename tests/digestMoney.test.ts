// The money section, and the rule it must never break: it is INTERNAL ONLY.
//
// A client sees their own money through their own portal token and nowhere
// else. The partner digest goes to five people at a lab and is not a place to
// put a balance, somebody else's or even their own. That rule is one careless
// merge away from being untrue, so the last test here scans the whole rendered
// partner edition for anything currency-shaped.
import { describe, expect, it } from "vitest";
import type { PendingItem } from "@/lib/digest";
import { partnerPreheader, partnerView, renderPartnerDigest, renderPartnerDigestText } from "@/lib/digestPartner";
import { moneyLines, renderMoneySection, renderMoneyText, type MoneyInput } from "@/lib/digestMoney";
import { TONE_HEX } from "@/lib/tones";

const empty: MoneyInput = {
  unbilled: [], brokenPromises: [], openDisputes: [], overdue: [], onHold: [],
};

const full: MoneyInput = {
  unbilled: [
    { number: "WO-0398", orgName: "Lab Zen", daysClosed: 6, valueCents: 432000 },
    { number: "WO-0410", orgName: "Lab Zen", daysClosed: 1, valueCents: 90000 },
  ],
  brokenPromises: [
    { number: "INV-0087", orgName: "Coastal Analytical", byName: "K. Osei", promisedOn: "2026-08-20", daysPast: 2, payableCents: 395800 },
  ],
  openDisputes: [
    { number: "INV-0092", orgName: "Lab Zen", reason: "membrane cartridge", daysOpen: 2, disputedCents: 34000, restCents: 84000 },
  ],
  overdue: [
    { number: "INV-0087", orgName: "Coastal Analytical", daysLate: 41, balanceCents: 395800 },
  ],
  onHold: [
    { orgName: "Coastal Analytical", balanceCents: 395800, oldestDaysLate: 41 },
  ],
};

describe("moneyLines", () => {
  it("says nothing when there is nothing", () => {
    expect(moneyLines(empty)).toEqual([]);
    expect(renderMoneySection(empty)).toBe("");
    expect(renderMoneyText(empty)).toEqual([]);
  });

  it("leads with unbilled work, because it is the leak nobody notices", () => {
    const lines = moneyLines(full);
    expect(lines[0].text).toContain("WO-0398 closed 6 days ago, $4,320 unbilled");
    expect(lines[0].whose).toBe("Ours");
  });

  it("holds a just-closed job back for a day or two", () => {
    // WO-0410 closed yesterday: not yet a line, because "you have not invoiced
    // the job you finished last night" is noise, not news.
    expect(moneyLines(full).some((l) => l.text.includes("WO-0410"))).toBe(false);
  });

  it("calls an unanswered dispute ours and quotes what is still aging", () => {
    const d = moneyLines(full).find((l) => l.text.includes("INV-0092"));
    expect(d?.ours).toBe(true);
    expect(d?.text).toContain('disputed 2 days: "membrane cartridge"');
    expect(d?.text).toContain("the other $840 is still aging");
  });

  it("names the client on a broken promise and says whose move comes next", () => {
    const p = moneyLines(full).find((l) => l.text.includes("promised INV-0087"));
    expect(p?.whose).toBe("Coastal Analytical");
    expect(p?.ours).toBe(false);
    expect(p?.text).toContain("2 days past");
    expect(p?.text).toContain("theirs, then ours by the next rung");
  });

  it("puts a credit hold back on us - it is our decision to lift", () => {
    const h = moneyLines(full).find((l) => l.text.includes("credit hold"));
    expect(h?.ours).toBe(true);
    expect(h?.text).toContain("Coastal Analytical is on credit hold");
  });
});

describe("the section renders inside the internal email", () => {
  it("heads itself and totals the unbilled plus the past due", () => {
    const html = renderMoneySection(full);
    expect(html).toContain("MONEY, WHOSE MOVE");
    // $4,320 + $900 unbilled, plus $3,958 past due.
    expect(html).toContain("$9,178 between unbilled work and money past due");
  });

  it("takes its pill colours from the tone pairs, never a raw hex", () => {
    const html = renderMoneySection(full);
    expect(html).toContain(TONE_HEX.warn.bg);
    expect(html).toContain(TONE_HEX.neutral.fg);
  });

  it("has a plain-text twin", () => {
    const text = renderMoneyText(full);
    expect(text).toContain("MONEY, WHOSE MOVE");
    expect(text.join("\n")).toContain("Ours - WO-0398 closed 6 days ago");
  });
});

describe("the partner edition gains nothing", () => {
  const pending = (over: Partial<PendingItem> = {}): PendingItem => ({
    systemId: 1, externalId: "T-001", court: "partner", who: "Lab Zen",
    what: "No tracking yet for H-ESI needle seal", days: 5,
    cause: "part-tracking", subject: "H-ESI needle seal", ...over,
  });

  const v = partnerView({
    section: {
      name: "Lab Zen",
      board: [{
        externalId: "T-001", label: "Thermo Altis LC-MS/MS", stages: ["Waiting / blocked"],
        gases: [], openParts: 2, lead: "joe.vincent",
      }],
      pending: [pending(), pending({ court: "us", cause: "blocked", subject: "waiting on the client's PO number" })],
      handoffs: [{ externalId: "G-007", label: "Agilent UPLC", holder: "Lab Zen", reason: "repair complete", days: 1 }],
    },
    operatorName: "Sierra Spectra",
    dateLabel: "Sat Aug 22",
    portalUrl: "https://service.example.com",
    blockedStage: "Waiting / blocked",
    gapDays: 1,
    stageHex: () => TONE_HEX.bad,
    gasBlocking: (s) => s === "Empty" || s === "Low",
  });

  const html = renderPartnerDigest(v, partnerPreheader(v));
  const text = renderPartnerDigestText(v, partnerPreheader(v));

  it("carries no currency amount anywhere in the HTML", () => {
    // Any dollar sign at all, and any bare amount with a thousands separator
    // or cents. The partner edition has no legitimate use for either.
    expect(html).not.toMatch(/\$\s?\d/);
    expect(html).not.toMatch(/\b\d{1,3}(,\d{3})+(\.\d{2})?\b/);
    expect(html).not.toMatch(/\b\d+\.\d{2}\b/);
  });

  it("carries no currency amount in the plain-text edition either", () => {
    expect(text).not.toMatch(/\$\s?\d/);
    expect(text).not.toMatch(/\b\d{1,3}(,\d{3})+(\.\d{2})?\b/);
  });

  it("never names an invoice, a balance or a fee", () => {
    const both = `${html}\n${text}`.toLowerCase();
    for (const word of ["invoice", "past due", "balance", "late fee", "overdue", "credit hold", "collections"]) {
      expect(both).not.toContain(word);
    }
  });

  it("does not render the money section even if somebody hands it one", () => {
    // The section is composed by composeDigest, not by the partner renderer -
    // there is no seam here to pass it through, and that is the point.
    expect(renderPartnerDigest(v, partnerPreheader(v))).not.toContain("MONEY, WHOSE MOVE");
  });
});
