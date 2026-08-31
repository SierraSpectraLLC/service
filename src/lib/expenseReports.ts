/**
 * Reimbursement, as rules over expense rows.
 *
 * Pure - who may claim what, what a report comes to, and what its status
 * means - so the page and the actions read one authority and the tests can
 * hold it down without a database.
 */

export type PoolExpense = {
  id: number;
  kind: string;
  description: string;
  amountCents: number;
  incurredOn: string;
  billable: boolean;
  workOrderId: number | null;
  person: string;
  loggedBy: string;
  reportId: number | null;
};

/**
 * The expenses a person may put on a reimbursement report.
 *
 * Theirs means: the row NAMES them (overhead rows carry a person), or they
 * logged it against a job without naming anyone else. A row already on a
 * report is spoken for - the same receipt on two reports is the same money
 * paid twice.
 */
export function reimbursementPool(
  rows: PoolExpense[],
  me: { name: string; email: string },
): PoolExpense[] {
  const name = me.name.trim().toLowerCase();
  const email = me.email.trim().toLowerCase();
  return rows.filter((r) => {
    if (r.reportId !== null) return false;
    const p = r.person.trim().toLowerCase();
    if (p) return p === name;
    return r.loggedBy.trim().toLowerCase() === email;
  });
}

/**
 * May this person work somebody's claim - fill it, submit it, take it back?
 *
 * Their own, always: a report you cannot edit is a claim being processed about
 * you rather than for you, which is the same principle that gives everybody
 * their own payroll row.
 *
 * Anybody's in the workspace if they administer the people - HR, or the owner.
 * That is the whole point of the flag: somebody hands the office manager a
 * shoebox of receipts and the office manager files the claim. Matched on the
 * NAME because expense_reports.person is a directory name and not a foreign
 * key, and trimmed and lowercased on both sides so a stray capital does not
 * lock a person out of their own money.
 *
 * The TENANT is not this function's business. It has no way to know one, and
 * `person` is free text, so two service companies can genuinely both employ a
 * Steve Jones - the caller checks the report's own stamp first, and this is
 * the second of the two questions rather than the only one.
 */
export function mayWorkReport(
  me: { name: string; adminsPeople: boolean },
  report: { person: string },
): boolean {
  if (me.adminsPeople) return true;
  const mine = me.name.trim().toLowerCase();
  return mine !== "" && report.person.trim().toLowerCase() === mine;
}

/** What a set of rows comes to. The only total a report ever has. */
export const reportTotalCents = (rows: { amountCents: number }[]): number =>
  rows.reduce((n, r) => n + r.amountCents, 0);

export const REPORT_STATUSES = ["draft", "submitted", "paid", "returned"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_LABEL: Record<string, string> = {
  draft: "Draft",
  submitted: "Awaiting payout",
  paid: "Paid",
  returned: "Returned",
};

export const REPORT_TONE: Record<string, "neutral" | "warn" | "good" | "bad"> = {
  draft: "neutral",
  submitted: "warn",
  paid: "good",
  returned: "bad",
};

/** The statuses whose rows the engineer may still edit in place. */
export const editableReport = (status: string): boolean =>
  status === "draft" || status === "returned";

/**
 * A date span like "Jul 12 - Aug 3" for a report's rows, so a list of
 * reports reads as periods instead of ids.
 */
export function reportSpan(rows: { incurredOn: string }[]): string {
  const days = rows.map((r) => r.incurredOn).filter(Boolean).sort();
  if (!days.length) return "";
  const fmt = (iso: string) => {
    const d = new Date(`${iso}T12:00:00Z`);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  };
  const a = days[0], b = days[days.length - 1];
  return a === b ? fmt(a) : `${fmt(a)} - ${fmt(b)}`;
}

/**
 * Whether a report is still being ASSEMBLED - nobody has asked to be paid yet.
 *
 * The same two statuses editableReport names, read the other way round: that
 * one answers "may this be edited", this one answers "is this still in the
 * engineer's hands". They are the same pair today and they are not the same
 * question, which is why the desk asks this one by name.
 */
export const unsubmittedReport = (status: string): boolean =>
  status === "draft" || status === "returned";

export type DeskReport = { id: number; person: string; status: string };

/**
 * The reimbursement desk, split the way the people reading it think.
 *
 * `filling` is the half that did not exist. The desk showed the owner every
 * SUBMITTED claim and a tail of settled ones, so a draft an engineer opened in
 * March and never sent was invisible to everybody but its author - which is
 * precisely the report somebody needs to chase. An owner asking "what has my
 * shop got open" was being answered "what has been handed to you", and those
 * differ by exactly the claims nobody has got round to.
 *
 * Pure, and over rows the caller has already scoped to one workspace, for the
 * reason lib/hr's tests spell out at length: expense_reports.person is a
 * directory name and a name is not a scope.
 */
export function deskReports<T extends DeskReport>(rows: T[]): {
  awaiting: T[]; filling: T[]; paid: T[];
} {
  return {
    awaiting: rows.filter((r) => r.status === "submitted"),
    filling: rows.filter((r) => unsubmittedReport(r.status)),
    paid: rows.filter((r) => r.status === "paid"),
  };
}

/** Everybody who has a report on this desk, once each, in reading order. */
export const reportPeople = (rows: DeskReport[]): string[] =>
  [...new Set(rows.map((r) => r.person.trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));

/**
 * What to call a report on a list.
 *
 * Its own name when it has one - every report opened from the desk now does,
 * because the form insists - and the old person-and-span fallback for every
 * report filed before it did. One function so the list, the record page and
 * the payout dialog cannot disagree about what a claim is called.
 */
export const reportTitle = (
  report: { person: string; title: string },
  rows: { incurredOn: string }[],
): string =>
  report.title.trim() || `${report.person} - ${reportSpan(rows) || "expense report"}`;

/**
 * A report's name, as the create form must have it.
 *
 * Naming is no longer optional. A desk where the owner can see every claim -
 * including the drafts nobody has sent - is a desk with a lot of rows on it,
 * and "Steve Jones, Jul 12 - Aug 3" three times over is not a list anybody can
 * work. The check lives here so the dialog can grey its own button on the same
 * rule the action refuses on.
 */
export const REPORT_TITLE_MAX = 120;
export function checkReportTitle(raw: string): { title: string } | { error: string } {
  const title = raw.trim().slice(0, REPORT_TITLE_MAX);
  if (!title) return { error: "Name the report - \"Reno install, week of the 12th\"" };
  return { title };
}

/**
 * WHAT AN AMENDMENT IS CALLED.
 *
 * A settled report is fixed - approved, and in the paid case the money has
 * already gone - so a receipt that surfaces afterwards cannot join it. What
 * people did was open a fresh report by hand and retype the trip, which leaves
 * two claims for one trip and nothing saying so. The amendment carries the
 * original's name so both are obviously the same trip, and says which pass it
 * is so three of them are still three distinguishable things.
 *
 * NUMBERED RATHER THAN STACKED. Amending an amendment gives "amendment 2", not
 * "amendment - amendment": the suffix is parsed off before the next one goes
 * on, so the name stays the trip's name however many times a receipt turns up
 * late. The base is trimmed to fit BEFORE the suffix is added, because a title
 * silently cut at 120 characters loses the word that says what it is.
 */
const AMEND_RE = /\s+[-–]\s+amendment(?:\s+(\d+))?$/i;

export function amendmentTitle(title: string): string {
  const raw = title.trim();
  const hit = AMEND_RE.exec(raw);
  const base = hit ? raw.slice(0, hit.index).trim() : raw;
  // "amendment", then "amendment 2" - the first correction needs no number,
  // and a shop with one of them should not have to read one.
  const next = hit ? (parseInt(hit[1] ?? "1", 10) || 1) + 1 : 1;
  const suffix = next === 1 ? " - amendment" : ` - amendment ${next}`;
  const room = REPORT_TITLE_MAX - suffix.length;
  const kept = base.length > room ? base.slice(0, room).trimEnd() : base;
  /* A report whose whole name WAS the suffix leaves nothing to hang it off,
     and "- amendment 2" names a dangling hyphen. The word stands on its own -
     which is also the honest answer for a report nobody named, back when
     naming one was optional. */
  if (!kept) return next === 1 ? "Amendment" : `Amendment ${next}`;
  return `${kept}${suffix}`;
}

/**
 * Is this report finished with, so far as its own rows are concerned?
 *
 * The mirror of editableReport, named for the question the amendment path
 * actually asks: a draft or a returned report takes the receipt directly and
 * needs no amendment at all, and offering one there would be offering a second
 * claim for money the first is still open to carry.
 */
export const settledReport = (status: string): boolean => !editableReport(status);
