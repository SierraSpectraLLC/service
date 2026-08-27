// What a month of being open costs, before a single job is touched.
//
// The overhead ledger already answers half of it: the internet bill, the
// software seat, the rent - anything with a receipt. Payroll is the other
// half, and the larger one in every service business, and it has no receipt to
// log. Without it "overhead" is a number that leaves out most of the money,
// which is worse than no number, because somebody will believe it.
//
// Two rules make this table different from everything else here.
//
// ACCESS RUNS THE OTHER WAY. Everywhere else, an operator's staff can read
// what sits inside their workspace - that is what a workspace IS. Payroll is
// the exception: a row belongs to the organization that employs the person,
// and only that organization's own administrators may read it. A client
// keeping payroll on a portal run by the company that services their
// instruments has to be able to trust that the company cannot read it, and a
// rule that lives only in a WHERE clause somewhere is not trust. So it lives
// here, pure, and is tested from both sides.
//
// HISTORY IS NOT EDITABLE. A raise in March must not change what January cost.
// Rows carry the day they took effect and the day they stopped, and a month's
// cost is summed from whatever was in force during it - the same
// nothing-is-stored doctrine the rest of Billing runs on.

/** How the amount on a row should be read. */
export type PayKind = "salary" | "hourly" | "monthly";

export const PAY_KINDS: { key: PayKind; label: string; unit: string; hint: string }[] = [
  { key: "salary", label: "Salary", unit: "a year", hint: "Annual pay, before employer costs" },
  { key: "hourly", label: "Hourly", unit: "an hour", hint: "A wage - the month rides on the hours below" },
  { key: "monthly", label: "Monthly", unit: "a month", hint: "A flat monthly cost - a retainer, a contractor" },
];

export type PayRow = {
  id: number;
  orgId: number;
  personEmail: string;
  name: string;
  title: string;
  kind: string;
  amountCents: number;
  hoursPerWeek: number;
  ftePct: number;
  burdenPct: number;
  effectiveOn: string;
  endsOn: string;
  note: string;
};

/**
 * Who is asking. Deliberately not the session user: the rule needs four facts
 * and nothing else, so it can be reasoned about and tested without a database.
 */
export type PayrollViewer = {
  email: string;
  /** owner | staff | client_editor | client_viewer */
  role: string;
  /** The organization a client belongs to. Null for the house. */
  orgId: number | null;
  /** The operator whose workspace this person is staff OF. Null for a client. */
  operatorOrgId: number | null;
  /**
   * The flag somebody turned on for them by hand: a client's
   * clientAllowlist.canSeePayroll, or a house member's
   * houseMembers.canAdminPeople. One field because it answers one question on
   * both sides - may this person read a register that is not their own row -
   * and because two fields would be two chances for a caller to fill in the
   * wrong one and get a `false` that looks like a rule rather than a bug.
   * lib/hr assembles it; nothing else should.
   */
  canSeePayroll: boolean;
};

/**
 * May this viewer read `orgId`'s payroll - everybody's pay, not just theirs?
 *
 * The house side: an operator's OWNER reads their own company's payroll, and
 * so does whoever that owner has made HR - somebody has to run the payout, and
 * in most companies of this size it is not the owner. Ordinary staff do not,
 * and no operator reads a client's, however the id arrives. There is
 * deliberately no platform-staff bypass: the one account that can see
 * everything else on the instance cannot see this, because "everything else"
 * was never meant to include what somebody's colleague earns.
 *
 * The client side: their own organization's, and only with the flag.
 *
 * Note what this does NOT grant, in either direction. lib/books is a separate
 * rule and stays owner-only on the house side, so HR reads what the company
 * pays its people without reading what it invoiced its clients. The
 * implication runs one way and tests/payroll pins it: anyone who may read the
 * books may read the payroll, never the reverse.
 */
export function maySeePayroll(v: PayrollViewer, orgId: number): boolean {
  if (v.role === "owner" || v.role === "staff") {
    if (v.operatorOrgId === null || v.operatorOrgId !== orgId) return false;
    return v.role === "owner" || v.canSeePayroll;
  }
  return v.canSeePayroll && v.orgId !== null && v.orgId === orgId;
}

/**
 * May they CHANGE it? Reading and writing part company for a client: a viewer
 * with the flag reads the register their manager keeps; an editor keeps it.
 */
export function mayEditPayroll(v: PayrollViewer, orgId: number): boolean {
  if (!maySeePayroll(v, orgId)) return false;
  // HR is deliberately not here. Reading the register is how they run a
  // payout; deciding what somebody is paid is the owner's, and the two are
  // different jobs even when one person happens to hold both.
  return v.role === "owner" || v.role === "client_editor";
}

/**
 * Everybody can see their OWN row, whatever else they can see - which is what
 * makes the register something a person can check rather than something kept
 * about them. Matched on the address, because that is the only identity a
 * payroll row and an account reliably share.
 */
export const isOwnRow = (v: PayrollViewer, row: { personEmail: string }): boolean =>
  !!v.email && row.personEmail.trim().toLowerCase() === v.email.trim().toLowerCase();

/** The rows this viewer may actually be handed, from an org's full register. */
export function visibleRows(v: PayrollViewer, orgId: number, rows: PayRow[]): PayRow[] {
  if (maySeePayroll(v, orgId)) return rows;
  return rows.filter((r) => isOwnRow(v, r));
}

// ---------------------------------------------------------------------------
// The arithmetic. Pure, so a month's cost can be argued with in a test.
// ---------------------------------------------------------------------------

/** Weeks in a month, averaged. 52/12 - not 4, which loses a month a year. */
const WEEKS_PER_MONTH = 52 / 12;

/**
 * What one row costs in a month, employer costs included.
 *
 * An hourly person's month is their normal week, not the hours they happened
 * to log: this is what it costs to KEEP somebody, which is the question
 * overhead asks. What their logged hours cost a particular job is job costing,
 * and the two are different numbers on purpose.
 */
export function monthlyCostCents(row: Pick<PayRow, "kind" | "amountCents" | "hoursPerWeek" | "ftePct" | "burdenPct">): number {
  const fte = Math.max(0, row.ftePct) / 100;
  const base =
    row.kind === "hourly" ? row.amountCents * Math.max(0, row.hoursPerWeek) * WEEKS_PER_MONTH
    : row.kind === "monthly" ? row.amountCents
    : row.amountCents / 12;
  const burden = 1 + Math.max(0, row.burdenPct) / 100;
  return Math.round(base * fte * burden);
}

/** Was this row in force at any point during the month "YYYY-MM"? */
export function inForce(row: Pick<PayRow, "effectiveOn" | "endsOn">, ym: string): boolean {
  const firstOfMonth = `${ym}-01`;
  const lastOfMonth = `${ym}-31`;   // string compare; no month is longer
  const from = row.effectiveOn || "0000-00-00";
  if (from > lastOfMonth) return false;
  return !row.endsOn || row.endsOn >= firstOfMonth;
}

export type MonthPayroll = {
  ym: string;
  totalCents: number;
  people: { row: PayRow; monthlyCents: number }[];
  /** Whole-person equivalents, so "four people" is answerable from part-timers. */
  headcount: number;
};

/** One month of payroll, from whatever was in force during it. */
export function payrollForMonth(rows: PayRow[], ym: string): MonthPayroll {
  const people = rows.filter((r) => inForce(r, ym))
    .map((row) => ({ row, monthlyCents: monthlyCostCents(row) }))
    .sort((a, b) => b.monthlyCents - a.monthlyCents);
  return {
    ym,
    totalCents: people.reduce((n, p) => n + p.monthlyCents, 0),
    people,
    headcount: people.reduce((n, p) => n + Math.max(0, p.row.ftePct) / 100, 0),
  };
}

/**
 * What an hour of sold labor has to carry, given a month's whole cost and the
 * hours actually billed in it.
 *
 * This is the number job costing has been guessing at: an hour costs the shop
 * its share of the payroll, the rent and the van whether or not it was sold,
 * so the cost of a SOLD hour is everything divided by the ones that sold.
 * Zero billable hours has no answer - not an infinite one - and says so.
 */
export function loadedHourlyCents(monthlyCostCents: number, billableMinutes: number): number | null {
  if (billableMinutes <= 0) return null;
  return Math.round(monthlyCostCents / (billableMinutes / 60));
}

/**
 * How many hours have to sell, at a given rate, to cover a month. The other
 * side of the same coin, and the one an owner actually plans against.
 */
export function breakEvenHours(monthlyCostCents: number, hourlyRateCents: number): number | null {
  if (hourlyRateCents <= 0) return null;
  return Math.round((monthlyCostCents / hourlyRateCents) * 10) / 10;
}

/** "2026-08" -> "August 2026". */
export function monthName(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  return `${["January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December"][m - 1]} ${y}`;
}

/** The months to show, newest first: this one and the `n-1` before it. */
export function recentMonths(today: string, n: number): string[] {
  const [y, m] = today.slice(0, 7).split("-").map(Number);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const month = m - i;
    const year = y + Math.floor((month - 1) / 12);
    const mm = ((month - 1 + 1200) % 12) + 1;
    out.push(`${year}-${String(mm).padStart(2, "0")}`);
  }
  return out;
}
