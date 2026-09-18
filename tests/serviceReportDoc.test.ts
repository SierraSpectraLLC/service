// What the service report SAYS, from a finished job.
//
// The document is a reproduction of one Sierra Spectra has been sending for
// years (tests/serviceReport covers the drawing of it); this covers the rules
// that decide its words and its arithmetic - above all the one that makes a
// contract visit readable: every line at its real price, and what the
// agreement covers taken off at the bottom, so the client can see what their
// retainer just paid for.
import { describe, expect, it } from "vitest";
import { reportTotals } from "@/lib/serviceReport";
import {
  addressLines, longVisitDate, serviceReportDoc, serviceTypeOf, unbilledTime, usd,
  type JobFacts, type ReportInput,
} from "@/lib/serviceReportDoc";

const JOB: JobFacts = {
  number: "030182", title: "Repair on Pump B",
  body: "Customer states Pump B not working; running pump isocratic.",
  requestedBy: "Prajita Pandey", openedOn: "2025-10-10",
  closeSummary: "Removed Pump Head B\n- Broken sapphire plunger discovered\nALL OK",
  closedOn: "2025-10-13", engineer: "Joe Harris",
  origin: "issue", severity: "Down", install: false,
};

const input = (over: Partial<ReportInput> = {}): ReportInput => ({
  number: "030182_SR6", issuedOn: "2025-10-13", visitDay: "2025-10-13",
  job: JOB,
  provider: {
    name: "Sierra Spectra", address: "6770 Stanford Ranch Rd.\nSuite #1220\nRoseville, CA 95678",
    contact: "Sierra Spectra | jrharris@sierraspectra.com",
  },
  customer: {
    name: "Emery Pharma", address: "1000 Atlantic Ave.,\nSuite #110\nAlameda, CA 94501",
    representative: "Prajita Pandey",
  },
  instrument: { type: "Thermo UPLC", model: "Vanquish Flex", serial: "8339399", module: "Pump VF-P10" },
  items: [
    { kind: "part", description: "Pump Head - Certified Working", partNumber: "6044.5201", qty: 1, unitCents: 225_000, covered: false },
    { kind: "part", description: "Sapphire Piston 2ct", partNumber: "6040.0042", qty: 1, unitCents: 48_300, covered: false },
    { kind: "travel", description: "Travel - Joe Harris", partNumber: "", qty: 1, unitCents: 40_000, covered: false },
    { kind: "labor", description: "Labor, on site - Joe Harris", partNumber: "", qty: 4, unitCents: 50_000, covered: false },
  ],
  contract: { visitNumber: "05", visitsRemaining: "01", partsRemaining: "$0.00" },
  partsTaxed: false,
  poNumber: "030182_Ar2",
  ...over,
});

describe("what kind of visit it was", () => {
  it("reads it off the job rather than asking again", () => {
    expect(serviceTypeOf({ origin: "issue", severity: "Down", install: false })).toBe("Repair");
    expect(serviceTypeOf({ origin: "pm_request", severity: "Planned", install: false })).toBe("PM");
    expect(serviceTypeOf({ origin: "", severity: "Question", install: false })).toBe("Support");
    // A commission is an install whatever anybody typed in the severity box.
    expect(serviceTypeOf({ origin: "pm_request", severity: "Planned", install: true })).toBe("Install");
  });
});

describe("the blocks at the top", () => {
  it("prints an address as its own lines, however it was typed", () => {
    expect(addressLines("1000 Atlantic Ave.,\nSuite #110\nAlameda, CA 94501"))
      .toEqual(["1000 Atlantic Ave.,", "Suite #110", "Alameda, CA 94501"]);
    // One-line addresses split at the last comma, so the town keeps its state.
    expect(addressLines("2393 Anglers Ct, Mariposa, CA 95338"))
      .toEqual(["2393 Anglers Ct, Mariposa", "CA 95338"]);
    expect(addressLines("")).toEqual([]);
  });

  it("writes the visit date the long way, and leaves anything else alone", () => {
    expect(longVisitDate("2025-10-13")).toBe("Monday, October 13, 2025");
    expect(longVisitDate("")).toBe("");
    expect(longVisitDate("last Tuesday")).toBe("last Tuesday");
  });

  it("carries the job's own words: what was asked, and what was done", () => {
    const r = serviceReportDoc(input());
    expect(r.reportNumber).toBe("030182_SR6");
    expect(r.visitDate).toBe("Monday, October 13, 2025");
    expect(r.serviceType).toBe("Repair");
    expect(r.visitNumber).toBe("05");
    expect(r.workCompleted).toBe("Repair on Pump B");
    expect(r.request).toEqual({ date: "2025-10-10", from: "Prajita Pandey", text: JOB.body });
    expect(r.notes).toEqual({ date: "2025-10-13", body: JOB.closeSummary });
    expect(r.poNumber).toBe("030182_Ar2");
    // The module the work was on, not the model of the stack it sits in.
    expect(r.instrument.module).toBe("Pump VF-P10");
    expect(r.signatures).toMatchObject({ providerName: "Joe Harris", customerName: "Prajita Pandey", customerOrg: "Emery Pharma" });
  });
});

describe("the two tables", () => {
  it("puts parts in one and everything that was worked or driven in the other", () => {
    const r = serviceReportDoc(input());
    expect(r.parts.map((l) => l.partNumber)).toEqual(["6044.5201", "6040.0042"]);
    expect(r.labor.map((l) => l.description)).toEqual(["Travel - Joe Harris", "Labor, on site - Joe Harris"]);
    expect(r.labor.every((l) => l.taxExempt)).toBe(true);
  });

  it("keeps the shop's own costs of getting there off a client's signature page", () => {
    // A per diem, the parking and a tank of fuel are an engineer's expense
    // claim. They belong on the invoice that charges them, not on the page a
    // client signs to say the work was done.
    const r = serviceReportDoc(input({
      items: [
        ...input().items,
        { kind: "expense", description: "Per diem, day trip - HAL Primary Lab", partNumber: "", qty: 1, unitCents: 3_000, covered: false },
        { kind: "expense", description: "Parking", partNumber: "", qty: 1, unitCents: 3_100, covered: false },
      ],
    }));
    expect(r.labor.map((l) => l.description)).toEqual(["Travel - Joe Harris", "Labor, on site - Joe Harris"]);
    expect(JSON.stringify(r)).not.toContain("Parking");
    // And they are not quietly summed into the money either.
    expect(reportTotals(r).due).toBe(513_300);
  });

  it("marks parts exempt where that site has no tax, and not where it has", () => {
    expect(serviceReportDoc(input()).parts.every((l) => l.taxExempt)).toBe(true);
    expect(serviceReportDoc(input({ partsTaxed: true })).parts.some((l) => l.taxExempt)).toBe(false);
  });

  it("totals the visit: parts, labour, and what is due", () => {
    const t = reportTotals(serviceReportDoc(input()));
    expect(t.parts).toBe(273_300);
    expect(t.labor).toBe(240_000);
    expect(t.sub).toBe(513_300);
    expect(t.adjustment).toBe(0);
    expect(t.due).toBe(513_300);
  });
});

describe("the hours nobody is charging for", () => {
  const rows = [
    { minutes: 240, category: "onsite", person: "Bill Harner", billable: false },
    { minutes: 60, category: "onsite", person: "Joe Harris", billable: false },
    { minutes: 150, category: "travel", person: "Bill Harner", billable: false },
    { minutes: 120, category: "onsite", person: "Bill Harner", billable: true },
  ];

  it("shows them at nothing, one line a category, whoever worked them", () => {
    expect(unbilledTime(rows)).toEqual([
      { kind: "labor", description: "Labor, on site - Bill Harner, Joe Harris - no charge", partNumber: "", qty: 5, unitCents: 0, covered: false },
      { kind: "travel", description: "Travel - Bill Harner - no charge", partNumber: "", qty: 2.5, unitCents: 0, covered: false },
    ]);
  });

  it("names the agreement that bought them, where one did", () => {
    expect(unbilledTime(rows, "030182_Ar2")[0].description)
      .toBe("Labor, on site - Bill Harner, Joe Harris - covered by 030182_Ar2");
  });

  it("leaves the billable ones to the invoice's own loader, and skips empty rows", () => {
    // 120 billable minutes are not here: they price at the rate card and
    // arrive with the rest of the draft.
    expect(unbilledTime(rows).reduce((n, i) => n + i.qty, 0)).toBe(7.5);
    expect(unbilledTime([{ minutes: 0, category: "remote", person: "Bill", billable: false }])).toEqual([]);
  });

  it("adds nothing to the money, which is the point of a zero", () => {
    const r = serviceReportDoc(input({
      items: [...input().items, ...unbilledTime(rows, "030182_Ar2")],
    }));
    const t = reportTotals(r);
    expect(r.labor).toHaveLength(4);
    expect(t.labor).toBe(240_000);          // the billable travel and labour, unchanged
    expect(t.due).toBe(513_300);
  });
});

describe("what the agreement absorbed", () => {
  it("prints covered work at its price and takes it off at the bottom", () => {
    // The whole argument for a retainer, on one page: the visit was worth
    // $5,133 and the client owes nothing.
    const covered = input({
      items: input().items.map((it) => ({ ...it, covered: true })),
    });
    const r = serviceReportDoc(covered);
    const t = reportTotals(r);
    expect(t.sub).toBe(513_300);
    expect(t.adjustment).toBe(-513_300);
    expect(t.due).toBe(0);
    // The lines keep their real prices - a zeroed table says nothing at all.
    expect(r.parts[0].unitCents).toBe(225_000);
  });

  it("adjusts only what was covered, so a part beyond the allowance still bills", () => {
    const mixed = input({
      items: input().items.map((it) => ({ ...it, covered: it.kind !== "part" })),
    });
    const t = reportTotals(serviceReportDoc(mixed));
    expect(t.adjustment).toBe(-240_000);
    expect(t.due).toBe(273_300);
  });

  it("carries the contract's own balances, and page one's parts figure", () => {
    const r = serviceReportDoc(input());
    expect(r.balances).toEqual({ visitsRemaining: "01", partsRemaining: "$0.00", partsTotal: "$2,733.00" });
  });

  it("says nothing rather than a zero where there is no contract", () => {
    const r = serviceReportDoc(input({ contract: { visitNumber: "", visitsRemaining: "", partsRemaining: "" } }));
    // The renderer prints a dash for a blank, which is what the original does.
    expect(r.visitNumber).toBe("");
    expect(r.balances.visitsRemaining).toBe("");
    expect(r.balances.partsRemaining).toBe("");
  });
});

describe("money on the page", () => {
  it("is written to the cent, always", () => {
    expect(usd(0)).toBe("$0.00");
    expect(usd(383_195)).toBe("$3,831.95");
    expect(usd(1_600_000)).toBe("$16,000.00");
  });
});
