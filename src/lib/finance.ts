// The shape of the financial section: what is in it, who may see each part,
// and over what window.
//
// Seven rooms over one journal. Every dollar on every one of them is SUM()
// over rows in lib/ledger; the rooms differ in which rows they show and how
// they are grouped, never in how a figure is computed. Position is the stocks
// (Home, Cash), Money is the two directions and the people at the other end
// (Receivables, Payables, Clients), Record is the journal itself and what is
// derived from it (Ledger, Reports).
//
// Pure, and separate from the components, because two things have to agree
// about it: the rail decides what to show, and the pages decide what to SUM.
// If those two ever disagree the lane totals leak a figure the rail was
// hiding, which is the one bug this file exists to make impossible.

export const PERIODS = ["month", "quarter", "ytd"] as const;
export type Period = (typeof PERIODS)[number];

export const isPeriod = (v: unknown): v is Period =>
  typeof v === "string" && (PERIODS as readonly string[]).includes(v);

/** The window this reader asked for; the calendar month when they didn't. */
export const periodFor = (v: unknown): Period => (isPeriod(v) ? v : "month");

export const PERIOD_LABEL: Record<Period, string> = {
  month: "This month",
  quarter: "Quarter",
  ytd: "Year to date",
};

/**
 * The first day in the window, as a shop-day string.
 *
 * Calendar boundaries, not rolling ones: a month is the thing an operator
 * reconciles against a bank statement, and "the last 30 days" reconciles
 * against nothing. The quarter is the calendar quarter containing today for
 * the same reason.
 */
export function periodStart(today: string, p: Period): string {
  const year = today.slice(0, 4);
  if (p === "ytd") return `${year}-01-01`;
  const month = Number(today.slice(5, 7));
  if (p === "month") return `${year}-${String(month).padStart(2, "0")}-01`;
  const firstOfQuarter = Math.floor((month - 1) / 3) * 3 + 1;
  return `${year}-${String(firstOfQuarter).padStart(2, "0")}-01`;
}

/**
 * The last day of the window - the other end of periodStart.
 *
 * Every other figure in the section is "so far": what was paid, what was
 * posted, up to today. Bills are the one figure that reaches FORWARD, because
 * "due this month" includes the 28th on the 3rd, so the window needs an end
 * as well as a start. Year to date ends at the year's end for the same
 * reason - the question is what the year commits us to, not what it has
 * charged so far.
 */
export function periodEnd(today: string, p: Period): string {
  const year = today.slice(0, 4);
  if (p === "ytd") return `${year}-12-31`;
  const month = Number(today.slice(5, 7));
  const lastMonth = p === "month" ? month : Math.floor((month - 1) / 3) * 3 + 3;
  const last = new Date(Date.UTC(Number(year), lastMonth, 0)).getUTCDate();
  return `${year}-${String(lastMonth).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
}

/** How the window reads in a sentence, once it is on screen. */
export function periodSpan(today: string, p: Period): string {
  const start = periodStart(today, p);
  return p === "month" ? monthLabel(start) : `${monthLabel(start)} to date`;
}

/** "this month" / "this quarter" / "this year" - the window inside a sentence. */
export function periodWord(p: Period): string {
  return p === "month" ? "this month" : p === "quarter" ? "this quarter" : "this year";
}

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

const monthLabel = (day: string): string =>
  `${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;

// ── The rail ────────────────────────────────────────────────────────────────

export const FINANCE_KEYS = [
  "overview", "cash",
  "receivables", "quotes", "payables", "clients",
  "ledger", "reports",
] as const;
export type FinanceKey = (typeof FINANCE_KEYS)[number];

/** Cents per room, for the rail's badge. Absent means "no figure to show". */
export type FinanceAmounts = Partial<Record<FinanceKey, number>>;
/** A badge that is not a dollar figure - "2 on hold" beside Clients. */
export type FinanceLabels = Partial<Record<FinanceKey, string>>;
/** A badge coloured because the figure is itself the problem. */
export type FinanceTones = Partial<Record<FinanceKey, "warn" | "bad">>;

export type FinanceEntry = {
  key: FinanceKey;
  label: string;
  href: string;
};

export type FinanceGroup = { label: string; entries: FinanceEntry[] };

/** Every room in the section, in the order the prototype draws them. */
const ENTRIES: (FinanceEntry & { group: string })[] = [
  { group: "Position", key: "overview", label: "Home", href: "/money" },
  { group: "Position", key: "cash", label: "Cash", href: "/money/cash" },

  { group: "Money", key: "receivables", label: "Receivables", href: "/money/receivables" },
  /* Quotes are the first stage of Receivables, and the one the shop reaches
     for most: the old menu's "Quotes" was the door people missed when the
     room was folded in. One entry, straight to that stage. */
  { group: "Money", key: "quotes", label: "Quotes", href: "/money/quotes" },
  { group: "Money", key: "payables", label: "Payables", href: "/money/payables" },
  { group: "Money", key: "clients", label: "Clients", href: "/money/clients" },

  { group: "Record", key: "ledger", label: "Ledger", href: "/money/ledger" },
  { group: "Record", key: "reports", label: "Reports", href: "/money/reports" },
];

const GROUP_ORDER = ["Position", "Money", "Record"];

/**
 * The two rooms that are not the books.
 *
 * Raising a purchase order and claiming back a hotel are things an engineer
 * DOES, not facts about how the business is doing, and both were doors of
 * their own before this section existed. They live in Operations, for
 * everybody - they were never rooms of this section for an engineer, and a
 * books reader reaches them from the same menu. See src/lib/nav.
 */
export const WORKING_ROOMS: readonly { href: string; label: string }[] = [
  { href: "/money/purchasing", label: "Purchasing" },
  /* "Reimbursements", not "Expenses": Overhead is also expenses, and two
     things by one name in one section is the confusion the financial merge
     exists to remove. */
  { href: "/money/reimbursements", label: "Reimbursements" },
] as const;

/** What a reader is allowed to be shown, as the two independent privileges. */
export type Visibility = {
  /** Whether this reader may read the shop's position at all - see lib/books. */
  seesBooks: boolean;
  /**
   * Whether they may read the payroll register - see lib/payroll. Not implied
   * by the books. It gates no room now: it gates the payroll rows inside
   * Payables and the payroll cost line in Reports. On its own it earns the
   * register, which is a page in the section but not a room of it.
   */
  seesPayroll: boolean;
};

/**
 * Where the old rooms went. Every old path answers with the room that
 * absorbed it, so a bookmark, a digest link or a muscle memory still lands.
 */
export const RETIRED_ROUTES: Record<string, string> = {
  "/money/invoices": "/money/receivables",
  "/money/collections": "/money/receivables?stage=pastdue",
  "/money/expenses": "/money/payables",
  "/money/bills": "/money/payables",
  "/money/costing": "/money/reports",
  "/money/contracts": "/money/clients",
};

/**
 * The section as a NAV group - the same rooms in the same order as the rail,
 * because a menu that drifts from the rail is two answers to "what is in
 * here". Every room is the books; a reader who may not read them gets none,
 * and HR - the register without the books - gets the one page that is theirs.
 */
export function financeNavItems(opts: Visibility): { href: string; label: string }[] {
  if (opts.seesBooks) return ENTRIES.map((e) => ({ href: e.href, label: e.label }));
  return opts.seesPayroll ? [{ href: "/money/payroll", label: "Payroll register" }] : [];
}

/** What each room is called, wherever it is named - rail, crumb or title. */
export const FINANCE_LABEL: Record<FinanceKey, string> =
  Object.fromEntries(ENTRIES.map((e) => [e.key, e.label])) as Record<FinanceKey, string>;

export const FINANCE_HREF: Record<FinanceKey, string> =
  Object.fromEntries(ENTRIES.map((e) => [e.key, e.href])) as Record<FinanceKey, string>;

/**
 * The rail this reader gets: every room for a books reader, nothing for
 * anybody else. Not greyed out, not a figure with the label removed - a rail
 * badge is a figure, and "Receivables $84,000" leaks the number whether or not
 * the link works.
 */
export function financeRail(opts: Visibility & { period?: Period }): FinanceGroup[] {
  if (!opts.seesBooks) return [];
  const period = opts.period ?? "month";
  return GROUP_ORDER
    .map((label) => ({
      label,
      entries: ENTRIES.filter((e) => e.group === label)
        .map(({ group: _group, ...e }) => ({ ...e, href: withPeriod(e.href, period) })),
    }))
    .filter((g) => g.entries.length > 0);
}

/**
 * Carry the window across a click. The default stays off the URL so /money is
 * still /money - a link somebody pastes into a message should not silently
 * pin the reader to whatever period the sender happened to be looking at.
 */
export function withPeriod(href: string, period: Period): string {
  if (period === "month") return href;
  return `${href}${href.includes("?") ? "&" : "?"}period=${period}`;
}

/**
 * The tone of the whole position: the worst fact in it, never the average.
 *
 * Being owed money is the ordinary state of a service business and reads calm.
 * Money past terms is amber the day it goes past; it turns red once it is a
 * big enough share of the receivable that the business is effectively lending
 * the money rather than waiting for it.
 */
export const PAST_DUE_SERIOUS = 0.25;

export function positionTone(owedCents: number, pastDueCents: number): "good" | "warn" | "bad" {
  if (pastDueCents <= 0) return "good";
  if (owedCents > 0 && pastDueCents / owedCents >= PAST_DUE_SERIOUS) return "bad";
  return "warn";
}

/** An invoice past this many days has stopped being late and become a problem. */
export const CHASE_DAYS = 45;
/** A quote unanswered this long is not being considered, it is being ignored. */
export const STALE_QUOTE_DAYS = 10;
/** Close enough to a renewal that terms have to be drafted now. */
export const RENEWAL_DAYS = 90;

/** The window as a day count, for anything that measures backwards from today. */
export function periodDays(today: string, p: Period): number {
  return Math.max(1, daysBetween(periodStart(today, p), today) + 1);
}

/** Whole days between two shop days, floor at zero. */
export function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 86400000)) : 0;
}

/** Signed days from one shop day to another - negative when `to` is earlier. */
export function daysFrom(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86400000) : 0;
}

/** A shop day plus some days. */
export function plusDays(day: string, n: number): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(t)) return day;
  return new Date(t + n * 86400000).toISOString().slice(0, 10);
}

/**
 * A contract's cost per month, whatever its billing rhythm.
 *
 * A quarterly retainer is not three times a monthly one, and adding the two
 * raw amounts together is how a committed-revenue figure ends up wrong by a
 * factor of three. Anything with no rhythm recorded contributes nothing rather
 * than being guessed at.
 */
export function monthlyContractCents(
  a: { billEveryMonths: number; billAmountCents: number },
): number {
  if (a.billEveryMonths <= 0 || a.billAmountCents <= 0) return 0;
  return Math.round(a.billAmountCents / a.billEveryMonths);
}

/**
 * The calendar months a window covers, so a quarter's payroll is three months
 * of it rather than one month counted once.
 */
export function monthsIn(today: string, period: Period): string[] {
  const start = periodStart(today, period);
  const out: string[] = [];
  let y = Number(start.slice(0, 4)), m = Number(start.slice(5, 7));
  const endY = Number(today.slice(0, 4)), endM = Number(today.slice(5, 7));
  while (y < endY || (y === endY && m <= endM)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

/** A year from a shop day, for "renewals coming up". */
export function addYear(today: string): string {
  return `${Number(today.slice(0, 4)) + 1}${today.slice(4)}`;
}
