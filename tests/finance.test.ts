import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import {
  FINANCE_KEYS, FINANCE_LABEL, PAST_DUE_SERIOUS, PERIODS,
  daysBetween, financeNavItems, financeRail, isPeriod, periodDays, periodFor, periodSpan, periodStart,
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
    const groups = financeRail({ seesBooks: true, seesPayroll: true });
    expect(groups.map((g) => g.label)).toEqual(["Position", "Money in", "Money out", "Analysis"]);
    expect(keysOf(groups)).toEqual([...FINANCE_KEYS]);
  });

  it("DROPS payroll entirely for a reader who may not read one", () => {
    const groups = financeRail({ seesBooks: true, seesPayroll: false });
    expect(keysOf(groups)).not.toContain("payroll");
    // Not hidden behind a disabled state either: nothing in the rendered rail
    // should so much as name it, because a badge is a figure.
    expect(JSON.stringify(groups)).not.toMatch(/payroll/i);
  });

  it("keeps every other room when payroll is dropped", () => {
    const without = keysOf(financeRail({ seesBooks: true, seesPayroll: false }));
    expect(without).toHaveLength(FINANCE_KEYS.length - 1);
    expect(without).toContain("overhead");
    expect(without).toContain("costing");
  });

  it("leaves a reader who may not read the books the two rooms that are theirs", () => {
    const groups = financeRail({ seesBooks: false, seesPayroll: false });
    expect(keysOf(groups)).toEqual(["purchasing", "reimbursements"]);
    // An engineer raises purchase orders and claims back what they spent, and
    // both were doors of their own before this section existed. Taking them
    // away with the books would not be a confidentiality rule, it would be a
    // broken app - see WORKING_ROOMS.
    expect(groups.map((g) => g.label)).toEqual(["Money out"]);
  });

  it("names no room a non-owner may not enter - not the overview, not costing", () => {
    const groups = financeRail({ seesBooks: false, seesPayroll: false });
    const rendered = JSON.stringify(groups);
    for (const gone of ["overview", "quotes", "invoices", "collections", "contracts", "overhead", "payroll", "costing"]) {
      expect(rendered).not.toMatch(new RegExp(gone, "i"));
    }
  });

  it("gives HR the register and none of the books", () => {
    /*
     * seesBooks false with seesPayroll true used to be unreachable, and this
     * test asserted the stricter answer for a pair that could only arrive by
     * mistake. It is now a person: the office manager an owner has made HR,
     * who runs the payout and has no business reading what the shop invoiced.
     *
     * So the pair is honoured rather than collapsed - and the interesting half
     * of the assertion is the second one. Payroll arriving must not drag a
     * single room of the position in behind it.
     */
    const groups = financeRail({ seesBooks: false, seesPayroll: true });
    expect(keysOf(groups)).toEqual(["purchasing", "reimbursements", "payroll"]);
    const rendered = JSON.stringify(groups);
    for (const gone of ["overview", "quotes", "invoices", "collections", "contracts", "overhead", "costing"]) {
      expect(rendered).not.toMatch(new RegExp(gone, "i"));
    }
  });

  it("draws the menu and the rail from one predicate", () => {
    // financeNavItems promises in its own comment that the menu cannot drift
    // from the rail. It is one filter now; this is what stops it becoming two
    // again.
    for (const seesBooks of [true, false]) {
      for (const seesPayroll of [true, false]) {
        const rail = financeRail({ seesBooks, seesPayroll })
          .flatMap((g) => g.entries).map((e) => e.href.split("?")[0]);
        const menu = financeNavItems({ seesBooks, seesPayroll }).map((i) => i.href);
        expect(`${seesBooks}/${seesPayroll}: ${menu.join(",")}`)
          .toBe(`${seesBooks}/${seesPayroll}: ${rail.join(",")}`);
      }
    }
  });

  it("carries the window across every link", () => {
    const groups = financeRail({ seesBooks: true, seesPayroll: true, period: "ytd" });
    for (const e of groups.flatMap((g) => g.entries)) {
      expect(e.href).toContain("period=ytd");
    }
  });

  it("points every room at /money, where they all now live", () => {
    const byKey = new Map(financeRail({ seesBooks: true, seesPayroll: true })
      .flatMap((g) => g.entries).map((e) => [e.key, e.href]));
    expect(byKey.get("purchasing")).toBe("/money/purchasing");
    expect(byKey.get("reimbursements")).toBe("/money/reimbursements");
    expect(byKey.get("payroll")).toBe("/money/payroll");
    expect(byKey.get("overhead")).toBe("/money/expenses");
    for (const href of byKey.values()) expect(href.startsWith("/money")).toBe(true);
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
  /** Source with comments removed, for assertions about what a file DOES. */
  const code = (src: string) => src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

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

  it("leaves payroll's own rule exactly as it was through the move", () => {
    const src = read("src/app/money/payroll/page.tsx");
    // Tenant-gated and row-filtered, NOT staff-gated: this is the rule the
    // whole section was shaped around.
    expect(src).toMatch(/maySeePayroll\(viewer, mine\)/);
    expect(src).toMatch(/visibleRows\(viewer, mine, all\)/);
    expect(src).not.toMatch(/if \(!isStaffRole\(user\.role\)\) redirect/);
  });

  it("gives a non-staff reader no rail on the two pages they can reach", () => {
    for (const p of ["src/app/money/purchasing/page.tsx", "src/app/money/payroll/page.tsx"]) {
      // The figures are not even computed for them - a number they may not
      // have never enters the request.
      expect(read(p), p).toMatch(/isStaffRole\(user\.role\)\s*\n?\s*\?\s*await railContext|isStaffRole\(user\.role\) \? await railContext/);
    }
  });

  it("shows the rail on /payroll only where the page IS the section's room", () => {
    // Staff who may not read the register still reach /payroll for their own
    // row. That is a pay stub, not a section room: a rail whose nine other
    // links they can follow but whose tenth does not exist, with nothing
    // highlighted, is worse than no rail.
    const src = read("src/app/money/payroll/page.tsx");
    expect(src).toMatch(/const inSection = fin\?\.seesPayroll === true;/);
    expect(src).toMatch(/rail=\{inSection && fin/);
  });

  it("computes the section's permissions in exactly one place", () => {
    // Every page reads seesPayroll and seesBooks from the one context call
    // rather than deriving either, so the rail and the lane totals cannot
    // disagree. /payroll is the one exception and is excluded deliberately: it
    // keeps its OWN maySeePayroll call, which is what lets a client contact
    // with the flag still reach it - asserted just above, and the reason this
    // section is a rail rather than a permission boundary.
    const lib = read("src/lib/financeData.ts");
    expect(lib).toMatch(/export async function booksContext/);
    expect(lib).toMatch(/export async function railContext/);
    expect(lib).toMatch(/maySeePayroll\(/);
    expect(lib).toMatch(/maySeeBooks\(/);
    const pages = [
      "src/app/money/page.tsx", "src/app/money/quotes/page.tsx",
      "src/app/money/invoices/page.tsx", "src/app/money/collections/page.tsx",
      "src/app/money/contracts/page.tsx", "src/app/money/costing/page.tsx",
      "src/app/money/expenses/page.tsx", "src/app/money/reimbursements/page.tsx",
      "src/app/money/purchasing/page.tsx", "src/app/money/payroll/page.tsx",
    ];
    for (const p of pages) expect(read(p), p).toMatch(/(books|rail)Context\(user,/);
    for (const p of pages.filter((x) => x !== "src/app/money/payroll/page.tsx")) {
      // Comments stripped: the assertion is that these pages do not COMPUTE
      // the permission, and a page explaining in prose why it defers to
      // booksContext has to be able to name the function it is not calling.
      // Matching raw text made the explanation of the rule read as a breach
      // of it.
      expect(code(read(p)), p).not.toMatch(/maySeePayroll/);
    }
    // And nobody asks the books question for themselves on a page. Comments
    // stripped for the same reason as above.
    for (const p of pages) expect(code(read(p)), p).not.toMatch(/maySeeBooks/);
  });

  it("READS THE BOOKS ONLY THROUGH THE CALL THAT GATES THEM", () => {
    // The eight rooms that are the shop's position all enter through
    // booksContext, which redirects a reader who may not read them. That is
    // deliberately the SAME call that hands over the figures: there is no
    // ordering in which a page fetches first and checks afterwards, and no
    // eleventh page that forgets the guard while remembering the data.
    for (const p of [
      "src/app/money/page.tsx", "src/app/money/quotes/page.tsx",
      "src/app/money/invoices/page.tsx", "src/app/money/collections/page.tsx",
      "src/app/money/contracts/page.tsx", "src/app/money/costing/page.tsx",
      "src/app/money/expenses/page.tsx",
    ]) {
      expect(read(p), p).toMatch(/booksContext\(user,/);
      expect(read(p), p).not.toMatch(/railContext/);
    }
    // And the two working rooms go the other way: they must NOT be gated,
    // because an engineer raises purchase orders and claims expenses.
    for (const p of ["src/app/money/purchasing/page.tsx", "src/app/money/reimbursements/page.tsx"]) {
      expect(read(p), p).toMatch(/railContext\(user,/);
      expect(read(p), p).not.toMatch(/booksContext/);
    }
    expect(read("src/lib/financeData.ts")).toMatch(/if \(!seesBooks\) redirect\("\/"\);/);
  });

  it("renders the same rail on all ten pages", () => {
    for (const p of [
      "src/app/money/page.tsx", "src/app/money/quotes/page.tsx",
      "src/app/money/invoices/page.tsx", "src/app/money/collections/page.tsx",
      "src/app/money/contracts/page.tsx", "src/app/money/costing/page.tsx",
      "src/app/money/expenses/page.tsx", "src/app/money/reimbursements/page.tsx",
      "src/app/money/purchasing/page.tsx", "src/app/money/payroll/page.tsx",
    ]) {
      expect(read(p), p).toMatch(/<FinanceShell/);
    }
    // And MoneyTabs is gone rather than left behind to rot.
    expect(existsSync("src/components/MoneyTabs.tsx")).toBe(false);
  });
});

describe("the route move", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  const OLD = ["/purchasing", "/expenses", "/payroll"] as const;

  it("leaves no source reference to an old path", () => {
    // A missed revalidatePath does NOT error: the mutation succeeds and the
    // page quietly serves stale data. That is why this is a scan and not a
    // memory of having checked.
    const files = walk("src");
    const misses: string[] = [];
    for (const f of files) {
      for (const line of read(f).split("\n")) {
        for (const old of OLD) {
          // Quoted or template-interpolated, but not as a prefix of the new
          // path and not inside a next.config redirect.
          const re = new RegExp(`["\`]${old}(?![\\w-])`);
          if (re.test(line) && !line.includes("/money" + old)) misses.push(`${f}: ${line.trim()}`);
        }
      }
    }
    expect(misses).toEqual([]);
  });

  it("converts every revalidatePath, including the interpolated ones", () => {
    const src = read("src/app/actions.ts");
    expect(src).not.toMatch(/revalidatePath\(["`]\/(purchasing|expenses|payroll)/);
    // And the new ones are actually there, so this cannot pass by deletion.
    expect((src.match(/revalidatePath\(["`]\/money\/purchasing/g) ?? [])).toHaveLength(5);
    expect((src.match(/revalidatePath\(["`]\/money\/reimbursements/g) ?? [])).toHaveLength(17);
    expect((src.match(/revalidatePath\(["`]\/money\/payroll/g) ?? [])).toHaveLength(4);
  });

  it("redirects every old path permanently, sub-paths included", () => {
    const cfg = read("next.config.mjs");
    for (const [from, to] of [
      ["/purchasing", "/money/purchasing"],
      ["/expenses", "/money/reimbursements"],
      ["/payroll", "/money/payroll"],
    ]) {
      expect(cfg).toContain(`source: "${from}", destination: "${to}", permanent: true`);
      expect(cfg).toContain(`source: "${from}/:path*", destination: "${to}/:path*", permanent: true`);
    }
  });

  it("put the pages where the rail says they are", () => {
    for (const p of [
      "src/app/money/purchasing/page.tsx", "src/app/money/purchasing/[id]/page.tsx",
      "src/app/money/reimbursements/page.tsx", "src/app/money/reimbursements/[id]/page.tsx",
      "src/app/money/payroll/page.tsx",
    ]) expect(existsSync(p), p).toBe(true);
    for (const p of ["src/app/purchasing", "src/app/expenses", "src/app/payroll"]) {
      expect(existsSync(p), p).toBe(false);
    }
  });
});

/** Every .ts/.tsx under a directory, so a scan cannot miss a new file. */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}
