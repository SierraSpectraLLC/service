import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import {
  FINANCE_KEYS, FINANCE_LABEL, PAST_DUE_SERIOUS, PERIODS,
  daysBetween, financeRail, isPeriod, periodDays, periodFor, periodSpan, periodStart,
  monthlyContractCents, monthsIn,
  positionTone, rankDecisions, withPeriod, type Decision,
} from "@/lib/finance";


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

  it("groups the section the way money moves through it", () => {
    const groups = financeRail({ seesPayroll: true });
    expect(groups.map((g) => g.label)).toEqual(["Position", "Money in", "Money out", "Analysis"]);
    expect(keysOf(groups)).toEqual([...FINANCE_KEYS]);
  });

  it("DROPS payroll entirely for a reader who may not read one", () => {
    const groups = financeRail({ seesPayroll: false });
    expect(keysOf(groups)).not.toContain("payroll");
    // Not hidden behind a disabled state either: nothing in the rendered rail
    // should so much as name it, because a badge is a figure.
    expect(JSON.stringify(groups)).not.toMatch(/payroll/i);
  });

  it("keeps every other room when payroll is dropped", () => {
    const without = keysOf(financeRail({ seesPayroll: false }));
    expect(without).toHaveLength(FINANCE_KEYS.length - 1);
    expect(without).toContain("overhead");
    expect(without).toContain("costing");
  });

  it("carries the window across every link", () => {
    const groups = financeRail({ seesPayroll: true, period: "ytd" });
    for (const e of groups.flatMap((g) => g.entries)) {
      expect(e.href).toContain("period=ytd");
    }
  });

  it("points at the paths these pages live at today", () => {
    const byKey = new Map(financeRail({ seesPayroll: true })
      .flatMap((g) => g.entries).map((e) => [e.key, e.href]));
    // PR 1 moves no routes. If these ever change, the redirects in PR 2 have
    // to land in the same commit.
    expect(byKey.get("purchasing")).toBe("/purchasing");
    expect(byKey.get("reimbursements")).toBe("/expenses");
    expect(byKey.get("payroll")).toBe("/payroll");
    expect(byKey.get("overhead")).toBe("/money/expenses");
  });

  it("names every room exactly once", () => {
    const labels = FINANCE_KEYS.map((k) => FINANCE_LABEL[k]);
    expect(new Set(labels).size).toBe(labels.length);
    expect(FINANCE_LABEL.reimbursements).toBe("Reimbursements");
    expect(FINANCE_LABEL.overhead).toBe("Overhead");
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
  const d = (key: string, tone: Decision["tone"]): Decision =>
    ({ key, tone, title: key, detail: "", href: "/money" });

  it("puts what is costing money today above what will cost it tomorrow", () => {
    const ranked = rankDecisions([d("a", "warn"), d("b", "bad"), d("c", "warn"), d("e", "bad")]);
    expect(ranked.map((x) => x.tone)).toEqual(["bad", "bad", "warn", "warn"]);
    // Stable within a tone, so the list does not reshuffle between renders.
    expect(ranked.map((x) => x.key)).toEqual(["b", "e", "a", "c"]);
  });

  it("does not mutate what it was handed", () => {
    const list = [d("a", "warn"), d("b", "bad")];
    rankDecisions(list);
    expect(list.map((x) => x.key)).toEqual(["a", "b"]);
  });
});

describe("contract value", () => {
  it("normalises a billing rhythm to one month", () => {
    expect(monthlyContractCents({ billEveryMonths: 1, billAmountCents: 1200_00 })).toBe(1200_00);
    // A quarterly retainer is not three times a monthly one.
    expect(monthlyContractCents({ billEveryMonths: 3, billAmountCents: 3600_00 })).toBe(1200_00);
    expect(monthlyContractCents({ billEveryMonths: 12, billAmountCents: 12000_00 })).toBe(1000_00);
  });

  it("contributes nothing rather than guessing at a missing rhythm", () => {
    expect(monthlyContractCents({ billEveryMonths: 0, billAmountCents: 1200_00 })).toBe(0);
    expect(monthlyContractCents({ billEveryMonths: 1, billAmountCents: 0 })).toBe(0);
  });
});

describe("the section is a rail, not a permission boundary", () => {
  const read = (p: string) => readFileSync(p, "utf8");

  it("has no /money/layout.tsx that could gate the section", () => {
    // Deliberate. A staff-only guard here would take payroll away from the
    // client contacts who legitimately reach /payroll today, because the rail
    // spans both. Each page keeps its own answer.
    expect(existsSync("src/app/money/layout.tsx")).toBe(false);
  });

  it("keeps the staff guard on every /money page", () => {
    for (const p of [
      "src/app/money/page.tsx", "src/app/money/quotes/page.tsx",
      "src/app/money/invoices/page.tsx", "src/app/money/collections/page.tsx",
      "src/app/money/contracts/page.tsx", "src/app/money/costing/page.tsx",
      "src/app/money/expenses/page.tsx",
    ]) {
      expect(read(p), p).toMatch(/if \(!isStaffRole\(user\.role\)\) redirect\("\/"\)/);
    }
  });

  it("leaves /payroll's own rule exactly as it was", () => {
    const src = read("src/app/payroll/page.tsx");
    // Tenant-gated and row-filtered, NOT staff-gated: this is the rule the
    // whole section was shaped around.
    expect(src).toMatch(/maySeePayroll\(viewer, mine\)/);
    expect(src).toMatch(/visibleRows\(viewer, mine, all\)/);
    expect(src).not.toMatch(/if \(!isStaffRole\(user\.role\)\) redirect/);
  });

  it("gives a non-staff reader no rail on the two pages they can reach", () => {
    for (const p of ["src/app/purchasing/page.tsx", "src/app/payroll/page.tsx"]) {
      // The figures are not even computed for them - a number they may not
      // have never enters the request.
      expect(read(p), p).toMatch(/isStaffRole\(user\.role\)\s*\n?\s*\?\s*await financeContext|isStaffRole\(user\.role\) \? await financeContext/);
    }
  });

  it("shows the rail on /payroll only where the page IS the section's room", () => {
    // Staff who may not read the register still reach /payroll for their own
    // row. That is a pay stub, not a section room: a rail whose nine other
    // links they can follow but whose tenth does not exist, with nothing
    // highlighted, is worse than no rail.
    const src = read("src/app/payroll/page.tsx");
    expect(src).toMatch(/const inSection = fin\?\.seesPayroll === true;/);
    expect(src).toMatch(/rail=\{inSection && fin/);
  });

  it("computes the section's permission in exactly one place", () => {
    // Every page reads seesPayroll from financeContext rather than deriving
    // it, so the rail and the lane totals cannot disagree. /payroll is the one
    // exception and is excluded deliberately: it keeps its OWN maySeePayroll
    // call, which is what lets a client contact with the flag still reach it -
    // asserted just above, and the reason this section is a rail rather than a
    // permission boundary.
    const lib = read("src/lib/financeData.ts");
    expect(lib).toMatch(/export async function financeContext/);
    expect(lib).toMatch(/maySeePayroll\(\{/);
    const pages = [
      "src/app/money/page.tsx", "src/app/money/quotes/page.tsx",
      "src/app/money/invoices/page.tsx", "src/app/money/collections/page.tsx",
      "src/app/money/contracts/page.tsx", "src/app/money/costing/page.tsx",
      "src/app/money/expenses/page.tsx", "src/app/expenses/page.tsx",
      "src/app/purchasing/page.tsx", "src/app/payroll/page.tsx",
    ];
    for (const p of pages) expect(read(p), p).toMatch(/financeContext\(user,/);
    for (const p of pages.filter((x) => x !== "src/app/payroll/page.tsx")) {
      expect(read(p), p).not.toMatch(/maySeePayroll/);
    }
  });

  it("renders the same rail on all ten pages", () => {
    for (const p of [
      "src/app/money/page.tsx", "src/app/money/quotes/page.tsx",
      "src/app/money/invoices/page.tsx", "src/app/money/collections/page.tsx",
      "src/app/money/contracts/page.tsx", "src/app/money/costing/page.tsx",
      "src/app/money/expenses/page.tsx", "src/app/expenses/page.tsx",
      "src/app/purchasing/page.tsx", "src/app/payroll/page.tsx",
    ]) {
      expect(read(p), p).toMatch(/<FinanceShell/);
    }
    // And MoneyTabs is gone rather than left behind to rot.
    expect(existsSync("src/components/MoneyTabs.tsx")).toBe(false);
  });
});
