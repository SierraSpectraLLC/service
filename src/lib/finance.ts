// The shape of the financial section: what is in it, who may see each part,
// and over what window.
//
// Billing, Purchasing, Reimbursements, Overhead and Payroll were five nav
// entries over one subject. A purchase order and an invoice are the same
// question asked from opposite ends - what is committed, and what is owed -
// and nothing in the app added them up, so the number an owner actually wants
// ("what is left") did not exist on any screen.
//
// Pure, and separate from the components, because two things have to agree
// about it: the rail decides what to show, and the overview decides what to
// SUM. If those two ever disagree the lane totals leak a figure the rail was
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

/** How the window reads in a sentence, once it is on screen. */
export function periodSpan(today: string, p: Period): string {
  const start = periodStart(today, p);
  return p === "month" ? monthLabel(start) : `${monthLabel(start)} to date`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

const monthLabel = (day: string): string =>
  `${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;

// ── The rail ────────────────────────────────────────────────────────────────

export const FINANCE_KEYS = [
  "overview",
  "quotes", "invoices", "collections", "contracts",
  "purchasing", "reimbursements", "overhead", "payroll",
  "costing",
] as const;
export type FinanceKey = (typeof FINANCE_KEYS)[number];

/** Cents per section, for the rail's badge. Absent means "no figure to show". */
export type FinanceAmounts = Partial<Record<FinanceKey, number>>;

export type FinanceEntry = {
  key: FinanceKey;
  label: string;
  href: string;
  /** Colours the badge when the figure is itself the problem. */
  tone?: "warn" | "bad";
};

export type FinanceGroup = { label: string; entries: FinanceEntry[] };

/**
 * Every room in the section, in the order money moves through it, at the paths
 * they live at TODAY. Purchasing, reimbursements and payroll still sit outside
 * /money; the rail reaches them anyway, which is the whole point of shipping
 * the section before the route moves.
 */
const ENTRIES: (FinanceEntry & { group: string })[] = [
  { group: "Position", key: "overview", label: "Overview", href: "/money" },

  { group: "Money in", key: "quotes", label: "Quotes", href: "/money/quotes" },
  { group: "Money in", key: "invoices", label: "Invoices", href: "/money/invoices" },
  { group: "Money in", key: "collections", label: "Collections", href: "/money/collections", tone: "bad" },
  { group: "Money in", key: "contracts", label: "Contracts", href: "/money/contracts" },

  { group: "Money out", key: "purchasing", label: "Purchasing", href: "/money/purchasing" },
  { group: "Money out", key: "reimbursements", label: "Reimbursements", href: "/money/reimbursements", tone: "warn" },
  { group: "Money out", key: "overhead", label: "Overhead", href: "/money/expenses" },
  { group: "Money out", key: "payroll", label: "Payroll", href: "/money/payroll" },

  { group: "Analysis", key: "costing", label: "Job costing", href: "/money/costing" },
];

const GROUP_ORDER = ["Position", "Money in", "Money out", "Analysis"];

/**
 * The two rooms that are not the books.
 *
 * Raising a purchase order and claiming back a hotel are things an engineer
 * DOES, not facts about how the business is doing, and both were doors of
 * their own before this section existed. Closing them along with the rest
 * would take a tech's own expense report away from the tech, which is not a
 * confidentiality rule, it is a broken app. Everything else here is the shop's
 * position and belongs to whoever owns the shop - see lib/books.
 *
 * So they are in every reader's rail and every reader's Financial menu. A
 * reader who has NO Financial menu - an ordinary engineer, who has neither the
 * books nor the register - reaches them from Operations instead, which is the
 * one place the app names them twice-over and it never names them twice to the
 * same person. See src/app/layout.tsx, where that fork is drawn.
 */
export const WORKING_ROOMS: readonly FinanceKey[] = ["purchasing", "reimbursements"] as const;

export const isWorkingRoom = (key: FinanceKey): boolean => WORKING_ROOMS.includes(key);

/**
 * The section as a NAV group - the same rooms in the same order as the rail,
 * because a menu that drifts from the rail is two answers to "what is in
 * here".
 *
 * Payroll leaves entirely for a reader who may not read one, on the same
 * reasoning as financeRail below: an entry naming a thing somebody cannot
 * have is worse than no entry.
 *
 * The two WORKING_ROOMS are always here, for every reader who gets this menu
 * at all. They are in Operations for everybody else - see WORKING_ROOMS above.
 * The split used to run the other way, listing them in both menus on the
 * reasoning that this one was owner-only and the two readerships never
 * overlapped. HR broke that: somebody who reads the register but not the books
 * has this menu too, and would have read the same two rooms twice.
 */
/** What a reader is allowed to be shown, as the two independent privileges. */
export type Visibility = {
  /** Whether this reader may read the shop's position at all - see lib/books. */
  seesBooks: boolean;
  /** Whether they may read the payroll register - see lib/payroll. Not implied by the books. */
  seesPayroll: boolean;
};

/**
 * Which rooms exist for this reader. ONE predicate, shared by the menu and the
 * rail, because the comment on financeNavItems promises they cannot drift and
 * two copies of a filter is how that promise gets broken.
 *
 * Three independent answers, not a ladder:
 *   - the two WORKING_ROOMS are everybody's, because they are things an
 *     engineer DOES;
 *   - Payroll is its own privilege. It used to require the books as well,
 *     which was true while the owner was the only person who could read a
 *     register and false the moment an owner could appoint HR - somebody who
 *     runs the payout without reading what the shop invoiced;
 *   - everything else is the books.
 */
const visible = (key: FinanceKey, opts: Visibility): boolean =>
  isWorkingRoom(key) ? true : key === "payroll" ? opts.seesPayroll : opts.seesBooks;

export function financeNavItems(opts: Visibility): { href: string; label: string }[] {
  return ENTRIES.filter((e) => visible(e.key, opts)).map((e) => ({ href: e.href, label: e.label }));
}

/** What each room is called, wherever it is named - rail, crumb or title. */
export const FINANCE_LABEL: Record<FinanceKey, string> =
  Object.fromEntries(ENTRIES.map((e) => [e.key, e.label])) as Record<FinanceKey, string>;

/**
 * The rail this reader gets.
 *
 * Payroll leaves entirely for anyone who may not read one - not greyed out,
 * not showing a figure with the label removed. An entry that names a thing
 * somebody cannot have is worse than no entry, and a rail badge is a figure:
 * "Payroll $18,600" leaks the number whether or not the link works.
 *
 * The books collapse the same way, and for the same reason. A reader who is
 * not the owner still reaches Purchasing and Reimbursements, so they still get
 * a rail; what they get is a rail of the two rooms that are theirs, with no
 * "Invoices $84,000" beside it. Dropping the LINKS while keeping the badges
 * would have been the leak this file exists to make impossible - the number is
 * the secret, not the anchor tag.
 */
export function financeRail(opts: Visibility & { period?: Period }): FinanceGroup[] {
  const period = opts.period ?? "month";
  const rooms = ENTRIES.filter((e) => visible(e.key, opts));
  return GROUP_ORDER
    .map((label) => ({
      label,
      entries: rooms.filter((e) => e.group === label)
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

/**
 * One thing somebody has to decide, from whichever ledger raised it.
 *
 * The argument for the whole section in one list. Every item here was already
 * visible somewhere before - an overdue invoice on Collections, an unanswered
 * quote on Quotes, a closed job on the overview, a renewal on Contracts, an
 * unapproved receipt on Reimbursements - on five pages, with nothing that put
 * them in one place or ranked them against each other.
 */
export type Decision = {
  key: string;
  /** Red is costing money today; amber is going to. */
  tone: "bad" | "warn";
  title: string;
  detail: string;
  href: string;
};

/** An invoice past this many days has stopped being late and become a problem. */
export const CHASE_DAYS = 45;
/** A quote unanswered this long is not being considered, it is being ignored. */
export const STALE_QUOTE_DAYS = 10;
/** Close enough to a renewal that terms have to be drafted now. */
export const RENEWAL_DAYS = 90;

/** Red first, then by size: the biggest thing you can fix today goes on top. */
export function rankDecisions(list: Decision[]): Decision[] {
  const weight = (d: Decision) => (d.tone === "bad" ? 0 : 1);
  return [...list].sort((a, b) => weight(a) - weight(b));
}

/** The window as a day count, for anything that measures backwards from today. */
export function periodDays(today: string, p: Period): number {
  return Math.max(1, daysBetween(periodStart(today, p), today) + 1);
}

/** Whole days between two shop days, floor at zero. */
export function daysBetween(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 86400000)) : 0;
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
