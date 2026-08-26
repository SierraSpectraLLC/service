// Who may read an organization's books.
//
// The financial section was gated on `isStaffRole`, which meant every engineer
// with a login could read what the shop had taken in, what each client owed,
// what the margin was on the job they had just finished, and what the business
// was worth per month in contracts. None of that is anybody's work. An engineer
// needs to raise a purchase order and claim back what they spent on the road;
// the shop's position is the owner's to read, and in most companies the owner's
// alone.
//
// This is lib/payroll's rule widened from one room to the section. Payroll got
// there first because gross pay is the obvious secret, but "what did we invoice
// LabZen" is the same kind of fact, and drawing the line at only the most
// embarrassing number is how the rest of it stays open by default.
//
// Pure - no database - so the rule can be argued with in a test and so the
// layout, the rail and every page ask it the same way.

/**
 * Who is asking. Five facts and nothing else, exactly as PayrollViewer: the
 * point of a viewer type is that the rule can be evaluated without a session.
 */
export type BooksViewer = {
  email: string;
  /** owner | staff | client_editor | client_viewer */
  role: string;
  /** The organization a client belongs to. Null for the house. */
  orgId: number | null;
  /** The operator whose workspace this person is staff OF. Null for a client. */
  operatorOrgId: number | null;
  /** Their allowlist flag - whether they may read their own org's money. */
  canSeeMoney: boolean;
};

/**
 * May this viewer read `orgId`'s books?
 *
 * The house side: an operator's OWNER reads their own company's, and nobody
 * else does. Not their staff, and not the platform account either - there is
 * deliberately no platform-staff bypass here for the same reason there is none
 * on payroll. An operator's books are the operator's.
 *
 * The client side: their own organization's, and only with the flag. A client
 * never reads an operator's books however the id arrives, because their orgId
 * is their own company and an operator's is not.
 */
export function maySeeBooks(v: BooksViewer, orgId: number): boolean {
  if (v.role === "owner" || v.role === "staff") {
    return v.role === "owner" && v.operatorOrgId !== null && v.operatorOrgId === orgId;
  }
  return v.canSeeMoney && v.orgId !== null && v.orgId === orgId;
}
