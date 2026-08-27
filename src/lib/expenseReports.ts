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
