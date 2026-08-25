// Payroll: who may read it, and what a month costs.
//
// The access half is tested from both sides on purpose. This is the one table
// where an operator's staff must NOT be able to read what sits inside their
// own workspace, and a rule that is only true because no query happens to ask
// is not a rule. The arithmetic half is tested because a month is not four
// weeks and a part-timer is not a person, and both mistakes make overhead look
// smaller than it is - which is the direction that costs somebody money.
import { describe, expect, it } from "vitest";
import {
  breakEvenHours, inForce, isOwnRow, loadedHourlyCents, maySeePayroll, mayEditPayroll,
  monthlyCostCents, monthName, payrollForMonth, recentMonths, visibleRows, type PayRow, type PayrollViewer,
} from "@/lib/payroll";

const viewer = (over: Partial<PayrollViewer> = {}): PayrollViewer => ({
  email: "", role: "client_viewer", orgId: null, operatorOrgId: null, canSeePayroll: false, ...over,
});

// Sierra Spectra is org 3 and runs the workspace; Lab Zen (1) is their client.
const SHOP_OWNER = viewer({ email: "joe@sierra.test", role: "owner", operatorOrgId: 3 });
const SHOP_STAFF = viewer({ email: "bill@sierra.test", role: "staff", operatorOrgId: 3 });
const RIVAL_OWNER = viewer({ email: "sam@rival.test", role: "owner", operatorOrgId: 4 });
const LZ_MANAGER = viewer({ email: "rita@labzen.test", role: "client_editor", orgId: 1, canSeePayroll: true });
const LZ_BOOKKEEPER = viewer({ email: "ap@labzen.test", role: "client_viewer", orgId: 1, canSeePayroll: true });
const LZ_TECH = viewer({ email: "tech@labzen.test", role: "client_editor", orgId: 1 });

describe("who may read an organization's payroll", () => {
  it("lets a service company's owner read their own company's", () => {
    expect(maySeePayroll(SHOP_OWNER, 3)).toBe(true);
    expect(mayEditPayroll(SHOP_OWNER, 3)).toBe(true);
  });

  it("does not let their own staff read it", () => {
    // An engineer seeing what the engineer at the next bench earns is the
    // incident this flag exists to prevent.
    expect(maySeePayroll(SHOP_STAFF, 3)).toBe(false);
    expect(mayEditPayroll(SHOP_STAFF, 3)).toBe(false);
  });

  it("NEVER lets the operator read a client's, however the id arrives", () => {
    // The whole bargain. Lab Zen's payroll sits in Sierra's workspace and
    // Sierra cannot read it.
    expect(maySeePayroll(SHOP_OWNER, 1)).toBe(false);
    expect(mayEditPayroll(SHOP_OWNER, 1)).toBe(false);
    expect(maySeePayroll(RIVAL_OWNER, 1)).toBe(false);
    expect(maySeePayroll(RIVAL_OWNER, 3)).toBe(false);
  });

  it("lets a client's own manager read and keep theirs", () => {
    expect(maySeePayroll(LZ_MANAGER, 1)).toBe(true);
    expect(mayEditPayroll(LZ_MANAGER, 1)).toBe(true);
  });

  it("keeps a client out of everybody else's, including the shop's", () => {
    expect(maySeePayroll(LZ_MANAGER, 2)).toBe(false);
    expect(maySeePayroll(LZ_MANAGER, 3)).toBe(false);
  });

  it("reads but does not write, without the editor role", () => {
    expect(maySeePayroll(LZ_BOOKKEEPER, 1)).toBe(true);
    expect(mayEditPayroll(LZ_BOOKKEEPER, 1)).toBe(false);
  });

  it("shows nothing to somebody at the org whose flag was never turned on", () => {
    // Default false, and being an editor is not a substitute for it.
    expect(maySeePayroll(LZ_TECH, 1)).toBe(false);
    expect(mayEditPayroll(LZ_TECH, 1)).toBe(false);
  });
});

describe("your own row", () => {
  const rows: PayRow[] = [
    { id: 1, orgId: 1, personEmail: "rita@labzen.test", name: "Rita", title: "", kind: "salary",
      amountCents: 12_000_000, hoursPerWeek: 40, ftePct: 100, burdenPct: 0, effectiveOn: "2026-01-01", endsOn: "", note: "" },
    { id: 2, orgId: 1, personEmail: "tech@labzen.test", name: "Tech", title: "", kind: "salary",
      amountCents: 8_000_000, hoursPerWeek: 40, ftePct: 100, burdenPct: 0, effectiveOn: "2026-01-01", endsOn: "", note: "" },
  ];

  it("is visible to the person it is about and nobody else's is", () => {
    expect(isOwnRow(LZ_TECH, rows[1])).toBe(true);
    expect(isOwnRow(LZ_TECH, rows[0])).toBe(false);
    const seen = visibleRows(LZ_TECH, 1, rows);
    expect(seen).toHaveLength(1);
    expect(seen[0].name).toBe("Tech");
  });

  it("matches on the address whatever case it was typed in", () => {
    expect(isOwnRow({ ...LZ_TECH, email: "TECH@LabZen.test" }, rows[1])).toBe(true);
  });

  it("gives the whole register to somebody who may read it", () => {
    expect(visibleRows(LZ_MANAGER, 1, rows)).toHaveLength(2);
  });

  it("gives a stranger nothing at all, not even by an empty address", () => {
    // A row with no email must not become everybody's own row.
    const noEmail: PayRow = { ...rows[0], id: 3, personEmail: "" };
    expect(visibleRows(viewer({ email: "" }), 1, [noEmail])).toEqual([]);
    expect(visibleRows(SHOP_OWNER, 1, rows)).toEqual([]);
  });
});

describe("what a month costs", () => {
  const row = (over: Partial<PayRow> = {}): PayRow => ({
    id: 1, orgId: 3, personEmail: "", name: "Somebody", title: "", kind: "salary",
    amountCents: 12_000_000, hoursPerWeek: 40, ftePct: 100, burdenPct: 0,
    effectiveOn: "2026-01-01", endsOn: "", note: "", ...over,
  });

  it("divides a salary by twelve", () => {
    expect(monthlyCostCents(row({ amountCents: 12_000_000 }))).toBe(1_000_000);
  });

  it("counts an hourly week as 52/12 weeks, not four", () => {
    // $50/h at 40 hours: 4.333 weeks a month, not 4. The difference is a
    // month's wages a year, always in the direction of looking cheaper.
    const m = monthlyCostCents(row({ kind: "hourly", amountCents: 5000, hoursPerWeek: 40 }));
    expect(m).toBe(Math.round(5000 * 40 * (52 / 12)));
    expect(m).toBeGreaterThan(5000 * 40 * 4);
  });

  it("takes a flat monthly cost as it stands", () => {
    expect(monthlyCostCents(row({ kind: "monthly", amountCents: 450_000 }))).toBe(450_000);
  });

  it("charges employer costs on top, and part time as a fraction", () => {
    expect(monthlyCostCents(row({ burdenPct: 25 }))).toBe(1_250_000);
    expect(monthlyCostCents(row({ ftePct: 50 }))).toBe(500_000);
    expect(monthlyCostCents(row({ ftePct: 50, burdenPct: 20 }))).toBe(600_000);
  });

  it("treats a contractor at no burden as exactly their pay", () => {
    expect(monthlyCostCents(row({ kind: "monthly", amountCents: 800_000, burdenPct: 0 }))).toBe(800_000);
  });
});

describe("which rows were in force", () => {
  const r = (effectiveOn: string, endsOn = "") => ({ effectiveOn, endsOn });

  it("counts somebody who started mid-month for that month", () => {
    expect(inForce(r("2026-08-20"), "2026-08")).toBe(true);
    expect(inForce(r("2026-09-01"), "2026-08")).toBe(false);
  });

  it("counts somebody who left mid-month, and not the month after", () => {
    expect(inForce(r("2026-01-01", "2026-08-14"), "2026-08")).toBe(true);
    expect(inForce(r("2026-01-01", "2026-08-14"), "2026-09")).toBe(false);
  });

  it("keeps a raise from rewriting the month before it", () => {
    // The old rate ended in March; the new one starts in March. February is
    // still February - which is the entire reason rows are dated.
    const before = r("2026-01-01", "2026-02-28");
    const after = r("2026-03-01");
    expect(inForce(before, "2026-02")).toBe(true);
    expect(inForce(after, "2026-02")).toBe(false);
    expect(inForce(after, "2026-03")).toBe(true);
  });
});

describe("the month, assembled", () => {
  const rows: PayRow[] = [
    { id: 1, orgId: 3, personEmail: "a@x.test", name: "Ann", title: "Engineer", kind: "salary",
      amountCents: 12_000_000, hoursPerWeek: 40, ftePct: 100, burdenPct: 20,
      effectiveOn: "2026-01-01", endsOn: "2026-06-30", note: "" },
    { id: 2, orgId: 3, personEmail: "a@x.test", name: "Ann", title: "Engineer", kind: "salary",
      amountCents: 13_200_000, hoursPerWeek: 40, ftePct: 100, burdenPct: 20,
      effectiveOn: "2026-07-01", endsOn: "", note: "" },
    { id: 3, orgId: 3, personEmail: "b@x.test", name: "Ben", title: "Apprentice", kind: "hourly",
      amountCents: 3000, hoursPerWeek: 20, ftePct: 50, burdenPct: 0,
      effectiveOn: "2026-01-01", endsOn: "", note: "" },
  ];

  it("uses the rate that was in force, not the newest one", () => {
    const june = payrollForMonth(rows, "2026-06");
    const july = payrollForMonth(rows, "2026-07");
    expect(june.people.find((p) => p.row.name === "Ann")!.monthlyCents).toBe(1_200_000);
    expect(july.people.find((p) => p.row.name === "Ann")!.monthlyCents).toBe(1_320_000);
    expect(july.totalCents).toBeGreaterThan(june.totalCents);
  });

  it("never counts one person twice across a raise", () => {
    const july = payrollForMonth(rows, "2026-07");
    expect(july.people.filter((p) => p.row.name === "Ann")).toHaveLength(1);
  });

  it("counts part timers as a fraction of a head", () => {
    expect(payrollForMonth(rows, "2026-07").headcount).toBe(1.5);
  });

  it("leads with the biggest line, because that is the one worth arguing with", () => {
    expect(payrollForMonth(rows, "2026-07").people[0].row.name).toBe("Ann");
  });
});

describe("what an hour has to carry", () => {
  it("divides the whole month across the hours that sold", () => {
    // $20,000 of cost, 100 billable hours: $200 an hour, not the wage.
    expect(loadedHourlyCents(2_000_000, 100 * 60)).toBe(20_000);
  });

  it("refuses to answer when nothing sold, rather than answering infinity", () => {
    expect(loadedHourlyCents(2_000_000, 0)).toBeNull();
  });

  it("says how many hours have to sell to cover the month", () => {
    expect(breakEvenHours(2_000_000, 16_500)).toBe(121.2);
    expect(breakEvenHours(2_000_000, 0)).toBeNull();
  });
});

describe("months, as people say them", () => {
  it("names one", () => {
    expect(monthName("2026-08")).toBe("August 2026");
  });

  it("walks back over a year boundary", () => {
    expect(recentMonths("2026-02-14", 4)).toEqual(["2026-02", "2026-01", "2025-12", "2025-11"]);
  });
});
