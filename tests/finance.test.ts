import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import {
  FINANCE_KEYS, FINANCE_LABEL, PAST_DUE_SERIOUS, PERIODS, RETIRED_ROUTES, WORKING_ROOMS,
  daysBetween, financeNavItems, financeRail, isPeriod, periodDays, periodFor, periodSpan, periodStart,
  monthlyContractCents, monthsIn,
  positionTone, withPeriod,
} from "@/lib/finance";
import { rankDecisions, type Decision } from "@/lib/money/decisions";


/**
 * The financial section's rules, as executable checks.
 *
 * The one that matters is the payroll rule. /payroll is not staff-gated - a
 * client contact with `canSeePayroll` reaches it - so the section had to be a
 * shared RAIL rather than a shared permission boundary. Every assertion about
 * who sees what is here rather than in prose, because "we remembered not to
 * add a layout guard" is not something a reviewer can check by reading.
 */

describe("the reporting window", () => {
  it("defaults to the calendar month", () => {
    expect(periodFor(undefined)).toBe("month");
    expect(periodFor("nonsense")).toBe("month");
    expect(periodFor("quarter")).toBe("quarter");
  });

  it("knows its own vocabulary", () => {
    expect(PERIODS).toEqual(["month", "quarter", "ytd"]);
    for (const p of PERIODS) expect(isPeriod(p)).toBe(true);
    expect(isPeriod("week")).toBe(false);
    expect(isPeriod(null)).toBe(false);
  });

  it("uses calendar boundaries, not rolling ones", () => {
    expect(periodStart("2026-08-25", "month")).toBe("2026-08-01");
    expect(periodStart("2026-08-25", "ytd")).toBe("2026-01-01");
    // August is in Q3, which starts in July.
    expect(periodStart("2026-08-25", "quarter")).toBe("2026-07-01");
    expect(periodStart("2026-01-14", "quarter")).toBe("2026-01-01");
    expect(periodStart("2026-12-31", "quarter")).toBe("2026-10-01");
    expect(periodStart("2026-04-01", "quarter")).toBe("2026-04-01");
  });

  it("counts at least one day, so nothing divides by zero", () => {
    expect(periodDays("2026-08-01", "month")).toBe(1);
    expect(periodDays("2026-08-25", "month")).toBe(25);
    expect(periodDays("2026-08-25", "ytd")).toBe(237);
  });

  it("names the window the way a person would say it", () => {
    expect(periodSpan("2026-08-25", "month")).toBe("August 2026");
    expect(periodSpan("2026-08-25", "quarter")).toBe("July 2026 to date");
  });

  it("covers every month a window touches, so a quarter is three payrolls", () => {
    expect(monthsIn("2026-08-25", "month")).toEqual(["2026-08"]);
    expect(monthsIn("2026-08-25", "quarter")).toEqual(["2026-07", "2026-08"]);
    expect(monthsIn("2026-08-25", "ytd")).toHaveLength(8);
    // A window that crosses a year boundary still walks forward correctly.
    expect(monthsIn("2026-02-10", "ytd")).toEqual(["2026-01", "2026-02"]);
  });

  it("keeps the default off the URL and carries the rest", () => {
    expect(withPeriod("/money", "month")).toBe("/money");
    expect(withPeriod("/money", "ytd")).toBe("/money?period=ytd");
    expect(withPeriod("/money/costing?f=x", "quarter")).toBe("/money/costing?f=x&period=quarter");
  });

  it("measures whole days and never goes negative", () => {
    expect(daysBetween("2026-08-01", "2026-08-25")).toBe(24);
    expect(daysBetween("2026-08-25", "2026-08-01")).toBe(0);
    expect(daysBetween("2026-08-25", "2026-08-25")).toBe(0);
  });
});

describe("the rail", () => {
  const keysOf = (groups: ReturnType<typeof financeRail>) =>
    groups.flatMap((g) => g.entries.map((e) => e.key));

  it("draws seven rooms over one journal, grouped as the prototype draws them", () => {
    const groups = financeRail({ seesBooks: true, seesPayroll: true });
    expect(groups.map((g) => g.label)).toEqual(["Position", "Money", "Record"]);
    expect(keysOf(groups)).toEqual([...FINANCE_KEYS]);
    expect(keysOf(groups)).toEqual(["overview", "cash", "receivables", "payables", "clients", "ledger", "reports"]);
  });

  it("payroll gates no room: the rail is the same with or without the register", () => {
    // seesPayroll now decides the payroll rows inside Payables and the payroll
    // cost line in Reports, not whether a room exists.
    expect(keysOf(financeRail({ seesBooks: true, seesPayroll: false }))).toEqual(keysOf(financeRail({ seesBooks: true, seesPayroll: true })));
    expect(JSON.stringify(financeRail({ seesBooks: true, seesPayroll: false }))).not.toMatch(/payroll/i);
  });

  it("gives a reader who may not read the books no rail at all", () => {
    // Not greyed out, not a figure with the label removed: a rail badge is a
    // figure, and "Receivables $84,000" leaks the number whether or not the
    // link works. The two working rooms are in Operations for everybody.
    expect(financeRail({ seesBooks: false, seesPayroll: false })).toEqual([]);
    expect(financeRail({ seesBooks: false, seesPayroll: true })).toEqual([]);
    expect(WORKING_ROOMS.map((r) => r.href)).toEqual(["/money/purchasing", "/money/reimbursements"]);
  });

  it("gives HR the register and none of the books", () => {
    // The office manager an owner has made HR runs the payout and has no
    // business reading what the shop invoiced. Their menu is one page - the
    // register, which is in the section but is not a room of it.
    expect(financeNavItems({ seesBooks: false, seesPayroll: true })).toEqual([{ href: "/money/payroll", label: "Payroll register" }]);
    expect(financeNavItems({ seesBooks: false, seesPayroll: false })).toEqual([]);
  });

  it("draws the menu and the rail from one list", () => {
    const rail = financeRail({ seesBooks: true, seesPayroll: true }).flatMap((g) => g.entries).map((e) => e.href);
    const menu = financeNavItems({ seesBooks: true, seesPayroll: true }).map((i) => i.href);
    expect(menu).toEqual(rail);
  });

  it("carries the window across every link", () => {
    const groups = financeRail({ seesBooks: true, seesPayroll: true, period: "ytd" });
    for (const e of groups.flatMap((g) => g.entries)) {
      expect(e.href).toContain("period=ytd");
    }
  });

  it("points every room at /money, and every old room at the one that absorbed it", () => {
    const byKey = new Map(financeRail({ seesBooks: true, seesPayroll: true }).flatMap((g) => g.entries).map((e) => [e.key, e.href]));
    expect(byKey.get("overview")).toBe("/money");
    expect(byKey.get("cash")).toBe("/money/cash");
    expect(byKey.get("ledger")).toBe("/money/ledger");
    for (const href of byKey.values()) expect(href.startsWith("/money")).toBe(true);
    expect(RETIRED_ROUTES).toEqual({
      "/money/quotes": "/money/receivables?stage=quoted",
      "/money/invoices": "/money/receivables",
      "/money/collections": "/money/receivables?stage=pastdue",
      "/money/expenses": "/money/payables",
      "/money/bills": "/money/payables",
      "/money/costing": "/money/reports",
      "/money/contracts": "/money/clients",
    });
    // And each old path really is a redirect, not a page that quietly kept rendering.
    for (const old of Object.keys(RETIRED_ROUTES)) {
      const src = readFileSync(`src/app${old}/page.tsx`, "utf8");
      expect(src).toContain("redirect(");
      expect(src).toContain("RETIRED_ROUTES");
    }
  });

  it("names every room exactly once", () => {
    const labels = FINANCE_KEYS.map((k) => FINANCE_LABEL[k]);
    expect(new Set(labels).size).toBe(labels.length);
    expect(FINANCE_LABEL.overview).toBe("Home");
    expect(FINANCE_LABEL.receivables).toBe("Receivables");
  });
});

describe("the position", () => {
  it("is calm when nothing is past terms", () => {
    expect(positionTone(500_00, 0)).toBe("good");
  });

  it("goes amber the day something is late", () => {
    expect(positionTone(1000_00, 1_00)).toBe("warn");
  });

  it("goes red once late money is a serious share of the receivable", () => {
    expect(positionTone(1000_00, 250_00)).toBe("bad");
    expect(positionTone(1000_00, 249_00)).toBe("warn");
    expect(PAST_DUE_SERIOUS).toBe(0.25);
  });

  it("does not divide by zero when nothing is owed", () => {
    expect(positionTone(0, 0)).toBe("good");
    // Owed nothing but something is past due: still a problem, not a crash.
    expect(positionTone(0, 100_00)).toBe("warn");
  });
});

describe("decisions", () => {
  const d = (key: string, tone: Decision["tone"], cents = 0): Decision =>
    ({ key, tone, title: key, detail: "", cents, href: "/money", action: { kind: "link", href: "/money", label: "Open" } });

  it("puts what is costing money today above what will cost it tomorrow, biggest first inside a tone", () => {
    const ranked = rankDecisions([d("a", "warn", 5), d("b", "bad", 1), d("c", "warn", 9), d("e", "bad", 7), d("f", "", 99)]);
    expect(ranked.map((x) => x.tone)).toEqual(["bad", "bad", "warn", "warn", ""]);
    expect(ranked.map((x) => x.key)).toEqual(["e", "b", "c", "a", "f"]);
  });

  it("does not mutate what it was handed", () => {
    const list = [d("a", "warn"), d("b", "bad")];
    rankDecisions(list);
    expect(list.map((x) => x.key)).toEqual(["a", "b"]);
  });
});
