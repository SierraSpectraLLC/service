import { redirect } from "next/navigation";
import { and, eq, isNotNull, isNull, notExists, sql } from "drizzle-orm";
import { db } from "@/db";
import { clientAllowlist, expenseReports, expenses } from "@/db/schema";
import { myTenantOrgId, type SessionUser } from "@/lib/authz";
import { shopToday } from "@/lib/shopday";
import { maySeePayroll } from "@/lib/payroll";
import { payrollViewerFor } from "@/lib/hr";
import { maySeeBooks, type BooksViewer } from "@/lib/books";
import { periodFor, type FinanceAmounts, type FinanceLabels, type FinanceTones, type Period } from "@/lib/finance";
import { moneyFigures, type MoneyFigures } from "@/lib/money/figures";

/**
 * Who may read the section, and the one call every page in it makes.
 *
 * The figures themselves live in lib/money/figures now, and every dollar in
 * them is a sum over lib/ledger. What is left here is the permission question
 * and the gate: a page that worked out `seesPayroll` slightly differently
 * from the rail beside it was the leak this section had to be built around,
 * so both ask the one way, here.
 */

/**
 * Which expense rows are overhead.
 *
 * "No work order" was the whole rule, and it was right until a claim could be
 * filed against a client with no job (expense_reports.org_id). A plug bought
 * for LabZen on a handshake has no work order, but it is not what it cost the
 * shop to exist this month: it is what the shop absorbed for LabZen, and Job
 * costing counts it there. Leaving it here as well would show the same $24 as
 * two different kinds of money on two pages.
 *
 * One predicate for every reader (the register page's "other cost" column,
 * the parity check), so they cannot drift.
 */
export const overheadExpense = () => and(
  isNull(expenses.workOrderId),
  notExists(
    db.select({ one: sql`1` }).from(expenseReports).where(and(
      eq(expenseReports.id, expenses.reportId),
      isNotNull(expenseReports.orgId),
    )),
  ),
);

/**
 * Who this reader is, for both money questions at once.
 *
 * One lookup, because the two flags live in the same allowlist row and asking
 * twice is how a page ends up with a rail that disagrees with itself.
 */
export async function moneyViewer(user: SessionUser): Promise<{
  mine: number | null; seesBooks: boolean; seesPayroll: boolean;
}> {
  const mine = myTenantOrgId(user);
  const [allowRow] = user.orgId === null ? [] : await db
    .select({ canSeePayroll: clientAllowlist.canSeePayroll, canSeeMoney: clientAllowlist.canSeeMoney })
    .from(clientAllowlist)
    .where(eq(clientAllowlist.entry, user.email.trim().toLowerCase()));
  const shared = { email: user.email, role: user.role, orgId: user.orgId, operatorOrgId: mine };
  return {
    mine,
    seesBooks: mine !== null && maySeeBooks(
      { ...shared, canSeeMoney: allowRow?.canSeeMoney ?? true } satisfies BooksViewer, mine),
    // Through lib/hr, which is the only place that knows a house member can
    // earn the register too - the allowlist row above is a client's half of
    // the answer and would read `false` for every engineer in the shop.
    seesPayroll: mine !== null && maySeePayroll(await payrollViewerFor(user), mine),
  };
}

/**
 * May this person read the operator's books - the one question, asked from
 * outside the section. The dashboard's money card and the "Financial" nav
 * word both need it, and neither is a page in the section.
 */
export async function seesBooksFor(user: SessionUser): Promise<boolean> {
  return (await moneyViewer(user)).seesBooks;
}

export type RailContext = {
  period: Period;
  today: string;
  seesBooks: boolean;
  seesPayroll: boolean;
  amounts: FinanceAmounts;
  labels: FinanceLabels;
  tones: FinanceTones;
};

/**
 * Enough to draw the rail, and nothing else.
 *
 * A reader who may not read the books gets no figures - not zeroed, ABSENT,
 * so the rail has nothing to put a badge on. Zeroing them would have been the
 * leak with extra steps. The pages outside the rooms (a purchase order, a
 * claim, the register) ask this so a books reader still sees the section
 * around them and everybody else sees the page alone.
 */
export async function railContext(user: SessionUser, periodParam: unknown): Promise<RailContext> {
  const period = periodFor(periodParam);
  const today = shopToday();
  const { mine, seesBooks, seesPayroll } = await moneyViewer(user);
  if (!seesBooks) return { period, today, seesBooks, seesPayroll, amounts: {}, labels: {}, tones: {} };
  const f = await moneyFigures(mine, today, period, { seesPayroll });
  return { period, today, seesBooks, seesPayroll, amounts: f.amounts, labels: f.labels, tones: f.tones };
}

/**
 * Everything a room needs before it renders: the window, who this reader is
 * allowed to be shown, and every figure.
 *
 * IT ALSO IS THE GATE. Every room here is the shop's position, so a reader
 * who may not read the books is turned away by the same call that would have
 * handed them the figures - there is no way to render one of these pages
 * without asking. A guard the caller has to remember is a guard that gets
 * forgotten on the eleventh page; see lib/books for who gets through.
 */
export async function booksContext(user: SessionUser, periodParam: unknown): Promise<{
  period: Period;
  today: string;
  /** The reader's own workspace: the tenant every room reads. */
  mine: number;
  seesPayroll: boolean;
  figures: MoneyFigures;
  rail: RailContext;
}> {
  const period = periodFor(periodParam);
  const today = shopToday();
  const { mine, seesBooks, seesPayroll } = await moneyViewer(user);
  if (!seesBooks || mine === null) redirect("/");
  const figures = await moneyFigures(mine, today, period, { seesPayroll });
  return {
    period, today, mine, seesPayroll, figures,
    rail: { period, today, seesBooks: true, seesPayroll, amounts: figures.amounts, labels: figures.labels, tones: figures.tones },
  };
}
