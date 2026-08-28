// What a referral fee is worth, and who can see the parts of that.
// The rules are lib/referral and stay pure; this is the fetching.

import { and, eq, gte, inArray, lte, ne } from "drizzle-orm";
import { db } from "@/db";
import { clientShares, invoiceLines, invoices, orgs, referralFees } from "@/db/schema";
import { accruedCents, outstandingCents, type FeeRow } from "@/lib/referral";

/**
 * What the payer has billed this client inside the window.
 *
 * COMPUTED IN THE PAYER'S OWN WORKSPACE, and the only thing that ever leaves
 * it is the total. Scoped three ways at once and every one of them matters:
 * the payer's tenant (so it is their ledger, not somebody else's), the client
 * organization (so it is this referral's work and not their whole book), and
 * the window (so year two is not counted against a twelve-month deal).
 *
 * Drafts and voids are excluded because neither is money asked for. A draft is
 * a thing somebody is still writing, and counting it would have a referrer
 * chasing a fee on an invoice that never went out.
 */
export async function billedForFee(fee: {
  payerOrgId: number; clientOrgId: number | null; startsOn: string; endsOn: string;
}): Promise<number> {
  if (fee.clientOrgId === null) return 0;
  const rows = await db.select({ id: invoices.id }).from(invoices).where(and(
    eq(invoices.tenantOrgId, fee.payerOrgId),
    eq(invoices.orgId, fee.clientOrgId),
    ne(invoices.status, "draft"),
    ne(invoices.status, "void"),
    fee.startsOn ? gte(invoices.issuedOn, fee.startsOn) : undefined,
    fee.endsOn ? lte(invoices.issuedOn, fee.endsOn) : undefined,
  ));
  if (!rows.length) return 0;
  const lines = await db.select({
    invoiceId: invoiceLines.invoiceId, qty: invoiceLines.qty,
    unitCents: invoiceLines.unitCents, covered: invoiceLines.covered,
  }).from(invoiceLines).where(inArray(invoiceLines.invoiceId, rows.map((r) => r.id)));

  // The same arithmetic an invoice total uses: qty is thousandths, and a
  // covered line prices at zero because the contract already paid for it.
  return lines.reduce((n, l) =>
    n + (l.covered ? 0 : Math.round((l.qty / 1000) * l.unitCents)), 0);
}

export type LedgerFee = FeeRow & {
  id: number;
  shareId: number;
  payeeOrgId: number;
  payerOrgId: number;
  clientOrgId: number | null;
  clientName: string;
  otherName: string;
  note: string;
};

/**
 * The fees this workspace owes and is owed.
 *
 * `owed` reads rows stamped to somebody else - the payee's - by the one
 * predicate that makes them ours to see: we are the payer named on them.
 */
export async function feesFor(tenantOrgId: number | null): Promise<{
  earned: LedgerFee[]; owed: LedgerFee[];
}> {
  if (tenantOrgId === null) return { earned: [], owed: [] };
  const [earned, owed] = await Promise.all([
    db.select().from(referralFees).where(eq(referralFees.payeeOrgId, tenantOrgId)),
    db.select().from(referralFees).where(eq(referralFees.payerOrgId, tenantOrgId)),
  ]);
  const all = [...earned, ...owed];
  if (!all.length) return { earned: [], owed: [] };

  const orgIds = [...new Set(all.flatMap((f) =>
    [f.payeeOrgId, f.payerOrgId, f.clientOrgId].filter((x): x is number => x !== null)))];
  const names = new Map((await db.select({ id: orgs.id, name: orgs.name }).from(orgs)
    .where(inArray(orgs.id, orgIds))).map((o) => [o.id, o.name]));
  // The client's name off the SHARE's frozen payload would be the sender's
  // spelling; the payer's own org row is what the payer calls them. Both are
  // right, and the row each side reads is its own.
  const shape = (f: typeof referralFees.$inferSelect, other: number): LedgerFee => ({
    id: f.id, shareId: f.shareId,
    payeeOrgId: f.payeeOrgId, payerOrgId: f.payerOrgId, clientOrgId: f.clientOrgId,
    clientName: (f.clientOrgId !== null ? names.get(f.clientOrgId) : "") ?? "a client",
    otherName: names.get(other) ?? "another service company",
    kind: f.kind, feeCents: f.feeCents, feeBps: f.feeBps,
    startsOn: f.startsOn, endsOn: f.endsOn,
    billedCents: f.billedCents, billedFrom: f.billedFrom,
    paidCents: f.paidCents, status: f.status, note: f.note,
  });
  return {
    earned: earned.map((f) => shape(f, f.payerOrgId)),
    owed: owed.map((f) => shape(f, f.payeeOrgId)),
  };
}

/** One fee with the share behind it, for the actions that decide about it. */
export async function feeWithShare(id: number): Promise<
  { fee: typeof referralFees.$inferSelect; share: typeof clientShares.$inferSelect } | null
> {
  const [fee] = await db.select().from(referralFees).where(eq(referralFees.id, id));
  if (!fee) return null;
  const [share] = await db.select().from(clientShares).where(eq(clientShares.id, fee.shareId));
  return share ? { fee, share } : null;
}

/** Totals for a ledger heading. Waived rows count as nothing, not as settled. */
export function totals(rows: LedgerFee[]): { accrued: number; outstanding: number } {
  return {
    accrued: rows.reduce((n, f) => n + accruedCents(f), 0),
    outstanding: rows.reduce((n, f) => n + outstandingCents(f), 0),
  };
}
