"use server";

// The money actions: every mutation that moves a dollar, in one module.
//
// Each one keeps doing what it did in app/actions - the row it writes, the
// audit line it leaves, the authorization it checks - AND posts to the ledger
// through lib/ledger/postings. Authz stays here, server-side, unchanged:
// requireStaff/requireOwner for who may press the button, and houseOf() on
// the row for whose workspace the row is in, because the id arrived off the
// wire.
//
// The audit log records that somebody did something; the ledger records what
// it did to the money. Both are written here, every time, and neither is
// ever edited.

import crypto from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  disputes, expenseReports, expenses, invoiceFees, invoiceLines, invoices, ledgerEntries, orgs,
  payments, payroll, payrollRuns, poLines, promises, purchaseOrders, quotes, shareLinks, workOrders,
} from "@/db/schema";
import { houseOf, myTenantOrgId, requireOwner, requireStaff } from "@/lib/authz";
import { audit } from "@/lib/audit";
import { requireReason } from "@/lib/reason";
import { formatCents, parseMoney } from "@/lib/money";
import { shopToday } from "@/lib/shopday";
import { addDays, isIsoDay } from "@/lib/pm";
import { linesTotal } from "@/lib/billing";
import { invoiceView, isOpen, METHOD_LABEL, PAYMENT_METHODS } from "@/lib/statement";
import {
  asStatementRow, billingContext, creditFor, dueFor, invoiceById, invoicesForOrg,
} from "@/lib/invoiceData";
import { feeFor } from "@/lib/dunning";
import { depositToClear } from "@/lib/credit";
import { nextDocNumber } from "@/lib/docNumberData";
import { needsApproval } from "@/lib/expensePolicy";
import { reportTotalCents } from "@/lib/expenseReports";
import { assignableNames } from "@/lib/directory";
import { cleanExpenseKind } from "@/lib/expenseKind";
import { poTotals } from "@/lib/po";
import { mayEditPayroll, payrollForMonth, type PayRow } from "@/lib/payroll";
import { payrollViewerFor } from "@/lib/hr";
import {
  closeBooksThrough, closeProblem, LedgerError, reverse, sumAccount, entries as ledgerEntriesFor,
} from "@/lib/ledger";
import {
  monthWord, postDisputeCredit, postExpenseLogged, postFeeWaived, postInvoiceFee, postInvoicePayment,
  postInvoiceSent, postOpening, postPayrollRun, postPoPaid, postReportPaid, postTaxRemit,
  reverseInvoicePostings,
} from "@/lib/ledger/postings";

/** Where an invoice is read, so a write shows up everywhere it appears. */
function revInvoice(inv: { id: number; workOrderId: number | null }) {
  revalidatePath(`/money/invoices/${inv.id}`);
  revalidatePath("/money");
  revalidatePath("/money/receivables");
  revalidatePath("/money/ledger");
  if (inv.workOrderId) revalidatePath(`/work/${inv.workOrderId}`);
}

/** The rooms every posting changes. */
function revMoney() {
  revalidatePath("/money");
  revalidatePath("/money/cash");
  revalidatePath("/money/payables");
  revalidatePath("/money/ledger");
  revalidatePath("/money/reports");
}

/** A ledger refusal, in the words the screen shows. Anything else is a bug and rethrows. */
function ledgerRefusal(e: unknown): { error: string } {
  if (e instanceof LedgerError) return { error: e.message };
  throw e;
}

// ---------------- Invoices ----------------

export async function markInvoiceSent(id: number): Promise<{ error?: string; token?: string }> {
  const u = await requireStaff();
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, id));
  if (!inv || !houseOf(u, inv.tenantOrgId)) return { error: "Not found" };
  if (inv.status !== "draft") return { error: `${inv.number} has already been sent.` };
  const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id));
  if (!lines.length) return { error: "There is nothing on this invoice to send." };

  const [org] = await db.select().from(orgs).where(eq(orgs.id, inv.orgId));
  const issuedOn = shopToday();
  const dueOn = dueFor(org ?? null, issuedOn);

  const token = crypto.randomBytes(18).toString("base64url");
  await db.insert(shareLinks).values({
    token, kind: "invoice", orgId: inv.orgId, invoiceId: inv.id,
    label: `Invoice ${inv.number}`,
    // A bill stays readable well past its due date: a link that dies at day 30
    // is a link that dies exactly when collections starts needing it.
    expiresOn: addDays(issuedOn, 365),
    tenantOrgId: inv.tenantOrgId, createdBy: u.email,
  });

  await db.update(invoices).set({ status: "sent", issuedOn, dueOn, updatedAt: new Date() })
    .where(eq(invoices.id, id));

  // The send is what puts the money on the books: receivable up, revenue by
  // line kind, tax to the state, a held deposit applied. A $0 covered invoice
  // posts nothing, which is right - the contract paid at the installment.
  const [dep] = await db.select({ number: quotes.number }).from(quotes).where(eq(quotes.depositInvoiceId, inv.id));
  try {
    await postInvoiceSent({ inv: { ...inv, status: "sent", issuedOn, dueOn }, lines, depositFor: dep?.number ?? null, by: u.email });
  } catch (e) { return ledgerRefusal(e); }

  const total = linesTotal(lines.map((l) => ({
    kind: "part" as const, description: "", qty: l.qty / 1000,
    unitCents: l.unitCents, covered: l.covered, sourceId: null,
  })));
  await audit({
    actor: u.email, entityType: "invoice", entityId: id, tenantOrgId: inv.tenantOrgId,
    action: `marked ${inv.number} sent to ${org?.name ?? "the client"}: ${formatCents(total)}, due ${dueOn}`,
  });
  revInvoice(inv);
  return { token };
}

/**
 * Money arrived. Never edits a line and never edits another payment: a
 * mistake is corrected by a second row, so the ledger reads as what happened
 * rather than as what somebody last decided it should look like.
 *
 * The status column is nudged to partial or paid for the sake of a list that
 * has not summed anything yet; lib/statement still reconciles it against the
 * rows, and the rows win.
 */
export async function recordPayment(
  invoiceId: number,
  data: { method: string; amount: string; reference: string; receivedOn: string },
): Promise<{ error?: string }> {
  const u = await requireStaff();
  const cents = parseMoney(data.amount);
  if (cents === null || cents <= 0) return { error: "Enter an amount like 840.00" };
  const day = data.receivedOn.trim();
  if (!isIsoDay(day)) return { error: "Pick the date it arrived" };
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv || !houseOf(u, inv.tenantOrgId)) return { error: "Not found" };
  if (inv.status === "draft") return { error: `${inv.number} has not been sent yet.` };
  const method = (PAYMENT_METHODS as readonly string[]).includes(data.method) ? data.method : "other";

  const [row] = await db.insert(payments).values({
    tenantOrgId: inv.tenantOrgId, invoiceId, method, amountCents: cents,
    reference: data.reference.trim(), receivedOn: day, recordedBy: u.email,
  }).returning();
  // Bank up, receivable down. A closed month refuses it: the row above is
  // undone so the two books cannot disagree about whether the money came.
  try {
    await postInvoicePayment({ inv, payment: row, by: u.email });
  } catch (e) {
    await db.delete(payments).where(and(eq(payments.id, row.id), eq(payments.tenantOrgId, inv.tenantOrgId as number)));
    return ledgerRefusal(e);
  }

  await settleStatus(inv);
  const view = await currentView(invoiceId);
  await audit({
    actor: u.email, entityType: "invoice", entityId: invoiceId, tenantOrgId: inv.tenantOrgId,
    action: `recorded ${formatCents(cents)} by ${METHOD_LABEL[method].toLowerCase()} on ${inv.number}`
      + (row.reference ? ` (${row.reference})` : "")
      + (view ? ` - ${view.balanceCents <= 0 ? "paid in full" : `${formatCents(view.balanceCents)} still open`}` : ""),
  });
  revInvoice(inv);
  revMoney();
  return {};
}

async function currentView(invoiceId: number) {
  const full = await invoiceById(invoiceId);
  return full ? invoiceView(asStatementRow(full), shopToday()) : null;
}

/** Nudge the lifecycle word to what the rows now say. */
async function settleStatus(inv: typeof invoices.$inferSelect) {
  const view = await currentView(inv.id);
  if (!view || inv.status === "void" || inv.status === "referred" || inv.status === "draft") return;
  const next = view.balanceCents <= 0 ? "paid" : view.paidCents > 0 ? "partial" : "sent";
  if (next !== inv.status) {
    await db.update(invoices).set({ status: next, updatedAt: new Date() })
      .where(and(eq(invoices.id, inv.id), eq(invoices.tenantOrgId, inv.tenantOrgId as number)));
  }
}

/**
 * A payment that was never really there.
 *
 * The name stays; the behaviour is a REVERSAL. The ledger's entry is mirrored,
 * dated today, with the reason - the original row stays on the record. The
 * payments row goes, as it always did, so the invoice's own arithmetic agrees
 * with the ledger's. A payment the bank has confirmed cannot be undone from
 * here at all; that is corrected from the feed when the return shows up.
 */
export async function deletePayment(id: number, reason: string): Promise<{ error?: string }> {
  const u = await requireStaff();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const [row] = await db.select().from(payments).where(eq(payments.id, id));
  if (!row || !houseOf(u, row.tenantOrgId)) return {};
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, row.invoiceId));
  if (!inv) return {};
  const today = shopToday();
  const live = await ledgerEntriesFor({ tenant: inv.tenantOrgId, refType: "invoice", refId: String(inv.id), liveOnly: true });
  const mine = live.find((e) => e.lines.some((l) => l.account === "receivable" && l.creditCents === row.amountCents)
    && e.memo.startsWith("Payment on "));
  try {
    if (mine) await reverse({ entryId: mine.id, reason: why, postedBy: u.email, today });
  } catch (e) { return ledgerRefusal(e); }
  await db.delete(payments).where(and(eq(payments.id, id), eq(payments.tenantOrgId, row.tenantOrgId as number)));
  await settleStatus(inv);
  await audit({
    actor: u.email, entityType: "invoice", entityId: inv.id, tenantOrgId: inv.tenantOrgId,
    action: `reversed a ${formatCents(row.amountCents)} payment on ${inv.number} - reason: ${why}`,
    field: "reason", newValue: why,
  });
  revInvoice(inv);
  revMoney();
  return {};
}

/**
 * Void it. The row and its lines stay: an invoice number that vanishes is a
 * gap somebody has to explain to an auditor, and "voided on the 3rd because
 * it was billed to the wrong site" is the explanation. Its postings - the
 * send, any fees - are reversed, dated today.
 */
export async function voidInvoice(id: number, reason: string): Promise<{ error?: string }> {
  const u = await requireStaff();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, id));
  if (!inv || !houseOf(u, inv.tenantOrgId)) return { error: "Not found" };
  if (inv.status === "void") return {};
  const paid = await db.select().from(payments).where(eq(payments.invoiceId, id));
  if (paid.length) return { error: `${inv.number} has payments against it - reverse those first.` };
  try {
    await reverseInvoicePostings({ inv, today: shopToday(), by: u.email, reason: `voided - ${why}` });
  } catch (e) { return ledgerRefusal(e); }
  await db.update(invoices).set({ status: "void", updatedAt: new Date() })
    .where(and(eq(invoices.id, id), eq(invoices.tenantOrgId, inv.tenantOrgId as number)));
  await db.update(shareLinks).set({ revokedAt: new Date() }).where(eq(shareLinks.invoiceId, id));
  await audit({
    actor: u.email, entityType: "invoice", entityId: id, tenantOrgId: inv.tenantOrgId,
    action: `voided ${inv.number} - reason: ${why}`,
    field: "reason", newValue: why,
  });
  revInvoice(inv);
  revMoney();
  return {};
}

/**
 * Delete an invoice outright. Owner only, reason required, audited - the row
 * and its lines, fees, payments and share links go with it. What it posted
 * is reversed rather than deleted: the ledger keeps both halves. Void remains
 * the lighter option when the number should stay on the books.
 */
export async function deleteInvoice(id: number, reason: string): Promise<{ error?: string }> {
  const u = await requireOwner();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, id));
  if (!inv || !houseOf(u, inv.tenantOrgId)) return {};
  const paid = await db.select().from(payments).where(eq(payments.invoiceId, id));
  const total = paid.reduce((n, p) => n + p.amountCents, 0);
  try {
    await reverseInvoicePostings({ inv, today: shopToday(), by: u.email, reason: `deleted - ${why}` });
  } catch (e) { return ledgerRefusal(e); }
  await db.delete(invoices).where(and(eq(invoices.id, id), eq(invoices.tenantOrgId, inv.tenantOrgId as number)));   // children cascade
  await audit({
    actor: u.email, entityType: "invoice", entityId: id, tenantOrgId: inv.tenantOrgId,
    action: `deleted ${inv.number}${total > 0 ? ` (had ${formatCents(total)} in payments)` : ""} - reason: ${why}`,
    field: "reason", newValue: why,
  });
  revalidatePath("/money");
  revalidatePath("/money/invoices");
  revMoney();
  if (inv.workOrderId) revalidatePath(`/work/${inv.workOrderId}`);
  return {};
}

// ---------------- Collections ----------------
// Fees, promises, disputes. Nothing here stores a balance either: a fee is
// its own row, a waiver flags that row, and what is owed is still summed at
// render - by the ledger, now, as well as by lib/statement.

/**
 * Post the late charge this invoice has earned.
 *
 * The amount is computed here, not posted from the form: what somebody was
 * shown and what gets charged come from one function, so a page left open
 * cannot charge last week's interest. The basis sentence is stored with it -
 * "1.50% per month on $3,900 undisputed, 31 days past the 10-day grace
 * period" - because a year from now that is the only thing that can explain
 * the number.
 */
export async function postFee(invoiceId: number): Promise<{ error?: string; amountCents?: number }> {
  const u = await requireStaff();
  const full = await invoiceById(invoiceId);
  if (!full || !houseOf(u, full.row.tenantOrgId)) return { error: "Not found" };
  const today = shopToday();
  const view = invoiceView(asStatementRow(full), today);
  const { policy } = await billingContext(full.row.orgId);

  const quote = feeFor({
    policy, dueOn: full.row.dueOn, today,
    payableCents: view.payableCents,
    partsCents: full.lines.filter((l) => l.kind === "part" && !l.covered)
      .reduce((n, l) => n + Math.round((l.qty / 1000) * l.unitCents), 0),
    postedOn: full.fees.filter((f) => !f.waived).map((f) => f.postedOn),
  });
  if (quote.amountCents <= 0) return { error: quote.blocked || "There is no fee to post." };

  const [row] = await db.insert(invoiceFees).values({
    tenantOrgId: full.row.tenantOrgId, invoiceId,
    amountCents: quote.amountCents, basis: quote.basis,
    postedOn: today, postedBy: u.email,
  }).returning();
  await postInvoiceFee({ inv: full.row, fee: row });
  await audit({
    actor: u.email, entityType: "invoice", entityId: invoiceId, tenantOrgId: full.row.tenantOrgId,
    action: `posted a late fee of ${formatCents(row.amountCents)} on ${full.row.number} - ${row.basis}`,
  });
  revInvoice(full.row);
  revMoney();
  return { amountCents: row.amountCents };
}

/**
 * Take a fee back off.
 *
 * The row stays and gets flagged, because expecting to waive more than you
 * charge is the honest posture, and the record of having charged and then
 * waived is the part that is worth anything. The ledger gets the mirror as
 * its own entry - the charge and the waiver both stay on record.
 */
export async function waiveFee(feeId: number, reason: string): Promise<{ error?: string }> {
  const u = await requireStaff();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const [fee] = await db.select().from(invoiceFees).where(eq(invoiceFees.id, feeId));
  if (!fee || !houseOf(u, fee.tenantOrgId)) return { error: "Not found" };
  if (fee.waived) return {};
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, fee.invoiceId));
  const today = shopToday();
  await db.update(invoiceFees).set({ waived: true, waivedBy: u.email, waivedReason: why, waivedOn: today })
    .where(and(eq(invoiceFees.id, feeId), eq(invoiceFees.tenantOrgId, fee.tenantOrgId as number)));
  if (inv) await postFeeWaived({ inv, fee, on: today, by: u.email });
  await audit({
    actor: u.email, entityType: "invoice", entityId: fee.invoiceId, tenantOrgId: fee.tenantOrgId,
    action: `waived the ${formatCents(fee.amountCents)} late fee on ${inv?.number ?? "the invoice"} - reason: ${why}`,
    field: "reason", newValue: why,
  });
  if (inv) { await settleStatus(inv); revInvoice(inv); }
  revMoney();
  return {};
}

/**
 * "The check goes out Friday." Worth a row for one reason: the morning after
 * it is broken is when the conversation changes, and nobody remembers the
 * date without one.
 */
export async function logPromise(
  invoiceId: number, data: { promisedOn: string; byName: string; note: string },
): Promise<{ error?: string }> {
  const u = await requireStaff();
  const day = data.promisedOn.trim();
  if (!isIsoDay(day)) return { error: "Pick the day they said" };
  const who = data.byName.trim();
  if (!who) return { error: "Who said it? A promise with no name on it is a note." };
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv || !houseOf(u, inv.tenantOrgId)) return { error: "Not found" };
  const [row] = await db.insert(promises).values({
    tenantOrgId: inv.tenantOrgId, invoiceId, promisedOn: day,
    byName: who, note: data.note.trim(), loggedBy: u.email,
  }).returning();
  await audit({
    actor: u.email, entityType: "invoice", entityId: invoiceId, tenantOrgId: inv.tenantOrgId,
    action: `logged a promise on ${inv.number}: ${who} says by ${day}${row.note ? ` - ${row.note}` : ""}`,
  });
  revInvoice(inv);
  return {};
}

/** They paid it. Closes the promise so the ladder stops escalating on it. */
export async function keepPromise(promiseId: number): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [row] = await db.select().from(promises).where(eq(promises.id, promiseId));
  if (!row || !houseOf(u, row.tenantOrgId)) return { error: "Not found" };
  if (row.keptOn) return {};
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, row.invoiceId));
  const today = shopToday();
  await db.update(promises).set({ keptOn: today })
    .where(and(eq(promises.id, promiseId), eq(promises.tenantOrgId, row.tenantOrgId as number)));
  await audit({
    actor: u.email, entityType: "invoice", entityId: row.invoiceId, tenantOrgId: row.tenantOrgId,
    action: `${row.byName || "The client"} kept the promise on ${inv?.number ?? "the invoice"} (${row.promisedOn})`,
  });
  if (inv) revInvoice(inv);
  return {};
}

/**
 * The client has questioned a line.
 *
 * It pauses what the reminders ASK for on that line alone. The undisputed
 * remainder keeps aging and keeps being chased, because a fair question about
 * one cartridge must not buy ninety quiet days on the rest of the bill.
 */
export async function openDispute(
  invoiceId: number, data: { lineId: number | null; reason: string },
): Promise<{ error?: string }> {
  const u = await requireStaff();
  const why = requireReason(data.reason);
  if (typeof why !== "string") return why;
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv || !houseOf(u, inv.tenantOrgId)) return { error: "Not found" };
  let line: typeof invoiceLines.$inferSelect | undefined;
  if (data.lineId !== null) {
    [line] = await db.select().from(invoiceLines).where(eq(invoiceLines.id, data.lineId));
    if (!line || line.invoiceId !== invoiceId) return { error: "That line is not on this invoice" };
  }
  const [row] = await db.insert(disputes).values({
    tenantOrgId: inv.tenantOrgId, invoiceId, lineId: line?.id ?? null,
    reason: why, openedOn: shopToday(), openedBy: u.email,
  }).returning();
  await audit({
    actor: u.email, entityType: "invoice", entityId: invoiceId, tenantOrgId: inv.tenantOrgId,
    action: `opened a dispute on ${inv.number}${line ? `, line "${line.description}"` : ""} - ${row.reason}`,
    field: "reason", newValue: row.reason,
  });
  revInvoice(inv);
  return {};
}

/**
 * Settle it, one of two ways.
 *
 * "kept" means the line stands and the pause lifts. "credited" issues a
 * NEGATIVE line rather than editing the disputed one, so the invoice still
 * reconciles against the copy in the client's inbox and both facts - what was
 * charged and what was given back - stay on the record. The ledger posts the
 * credit against the line's own revenue account.
 */
export async function resolveDispute(
  disputeId: number, resolution: "kept" | "credited", note: string,
): Promise<{ error?: string }> {
  const u = await requireStaff();
  const [d] = await db.select().from(disputes).where(eq(disputes.id, disputeId));
  if (!d || !houseOf(u, d.tenantOrgId)) return { error: "Not found" };
  if (d.resolvedOn) return {};
  const [inv] = await db.select().from(invoices).where(eq(invoices.id, d.invoiceId));
  if (!inv) return { error: "Not found" };
  const today = shopToday();

  let credited = 0;
  if (resolution === "credited") {
    const [line] = d.lineId === null ? [undefined]
      : await db.select().from(invoiceLines).where(eq(invoiceLines.id, d.lineId));
    if (!line) return { error: "There is no line to credit - resolve it as kept, or credit by hand." };
    credited = Math.round((line.qty / 1000) * line.unitCents);
    const [last] = await db.select({ position: invoiceLines.position }).from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, d.invoiceId)).orderBy(desc(invoiceLines.position)).limit(1);
    await db.insert(invoiceLines).values({
      invoiceId: d.invoiceId, kind: "fee_ref",
      description: `Credit memo - ${line.description}`,
      detail: note.trim() || `dispute opened ${d.openedOn}`,
      qty: 1000, unitCents: -credited, covered: false,
      sourceId: line.id, position: (last?.position ?? 0) + 1,
    });
    if (inv.status !== "draft") {
      await postDisputeCredit({ inv, disputeId, creditedKind: line.kind, cents: credited, on: today, by: u.email });
    }
  }

  await db.update(disputes).set({
    resolvedOn: today, resolution, resolvedBy: u.email,
    reason: note.trim() ? `${d.reason} | resolved: ${note.trim()}` : d.reason,
  }).where(and(eq(disputes.id, disputeId), eq(disputes.tenantOrgId, d.tenantOrgId as number)));

  await audit({
    actor: u.email, entityType: "invoice", entityId: d.invoiceId, tenantOrgId: inv.tenantOrgId,
    action: resolution === "credited"
      ? `resolved a dispute on ${inv.number} with a credit of ${formatCents(credited)}${note.trim() ? ` - ${note.trim()}` : ""}`
      : `resolved a dispute on ${inv.number}: the line stands${note.trim() ? ` - ${note.trim()}` : ""}`,
  });
  await settleStatus(inv);
  revInvoice(inv);
  revMoney();
  return {};
}

/**
 * "Pay us this and we will come out."
 *
 * Raises a real invoice for the figure lib/credit.depositToClear computes, due
 * on receipt, because that is only an agreement once there is something to
 * pay against. It deliberately does NOT lift the hold: recording the payment
 * does that by arithmetic. Sent on creation, so it posts on creation - as a
 * charge, not a held deposit: nothing ever applies it to a later invoice.
 */
export async function requestDeposit(orgId: number, note: string): Promise<{ error?: string; id?: number }> {
  const u = await requireStaff();
  const today = shopToday();
  const mine = myTenantOrgId(u);
  const [org] = await db.select().from(orgs).where(eq(orgs.id, orgId));
  if (!org) return { error: "Not found" };

  const [standing, ctx] = await Promise.all([creditFor(orgId, today), billingContext(orgId)]);
  if (!standing.onHold && !standing.override) {
    return { error: `${org.name} is not on credit hold - there is nothing to clear.` };
  }
  const full = await invoicesForOrg(orgId);
  const open = full.map((f) => invoiceView(asStatementRow(f), today)).filter(isOpen);
  const cents = depositToClear({
    policy: ctx.policy,
    openInvoices: open.map((v) => ({ balanceCents: v.balanceCents, daysLate: v.daysLate })),
  });
  if (cents <= 0) return { error: "Nothing would clear it - the hold is on something else." };

  let last: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    const number = await nextDocNumber("invoice", mine);
    try {
      const [inv] = await db.insert(invoices).values({
        tenantOrgId: mine, orgId, number, status: "sent",
        issuedOn: today, dueOn: today,          // a deposit that is net 30 is not a deposit
        poNumber: org.poNumber,
        title: "Deposit to resume service",
        note: note.trim() || `Deposit to clear the credit hold on ${org.name}.`,
        createdBy: u.email,
      }).returning();
      const lines = await db.insert(invoiceLines).values({
        invoiceId: inv.id, kind: "fee_ref",
        description: "Deposit to resume service",
        detail: `enough to clear the hold on ${org.name}, due on receipt`,
        qty: 1000, unitCents: cents, covered: false, sourceId: null, position: 0,
      }).returning();
      await postInvoiceSent({ inv, lines, depositFor: null, by: u.email });
      await audit({
        actor: u.email, entityType: "invoice", entityId: inv.id, tenantOrgId: mine,
        action: `raised ${number}, a ${formatCents(cents)} deposit to clear ${org.name}'s credit hold`,
      });
      revInvoice(inv);
      revMoney();
      revalidatePath("/work");
      return { id: inv.id };
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

// ---------------- Cash ----------------

/**
 * What was in the bank on a day.
 *
 * The opening balance is the one figure the ledger cannot derive, so it is
 * the one entry an owner types: bank up against equity, dated the day the
 * balance is from. Changing it later is a reversal of the last one and a new
 * entry - the ledger keeps both - and the org row carries the current answer
 * for the pages that still read it.
 */
export async function setCashOpening(
  data: { amount: string; on: string },
): Promise<{ error?: string }> {
  const u = await requireOwner();
  const mine = myTenantOrgId(u);
  if (mine === null) return { error: "Your company is not set up" };
  const cents = parseMoney(data.amount);
  if (cents === null) return { error: "Enter the balance like 24,310.00" };
  const on = data.on.trim();
  if (!isIsoDay(on)) return { error: "Pick the day the balance is from" };
  const today = shopToday();
  if (on > today) return { error: "That day has not happened yet" };
  const [org] = await db.select().from(orgs).where(eq(orgs.id, mine));
  if (!org) return { error: "Not found" };

  // Every live opening entry goes; the new one lands on its own day. An
  // opening inside a closed month is history the close is allowed to hold -
  // the books before it were built on that figure.
  const live = await ledgerEntriesFor({ tenant: mine, refType: "opening", refId: String(mine), liveOnly: true });
  try {
    for (const e of live) await reverse({ entryId: e.id, reason: "balance re-entered", postedBy: u.email, today });
    await postOpening({ tenantOrgId: mine, cents, on, by: u.email });
  } catch (e) { return ledgerRefusal(e); }

  await db.update(orgs).set({ cashOpeningCents: cents, cashOpeningOn: on }).where(eq(orgs.id, mine));
  await audit({
    actor: u.email, entityType: "org", entityId: mine, tenantOrgId: mine,
    action: `set the bank balance to ${formatCents(cents)} as of ${on}`
      + (org.cashOpeningOn ? ` (was ${formatCents(org.cashOpeningCents)} as of ${org.cashOpeningOn})` : ""),
    field: "cash_opening",
    oldValue: org.cashOpeningOn ? `${org.cashOpeningCents} @ ${org.cashOpeningOn}` : "",
    newValue: `${cents} @ ${on}`,
  });
  revMoney();
  revalidatePath("/owner");
  return {};
}

// ---------------- Money out ----------------

/**
 * Pay a reimbursement claim.
 *
 * requireOwner is "an owner of some service company", and expense_reports is
 * one instance-wide table - so houseOf on the row is the wall. Field expenses
 * up, bank down, dated the day it was paid; against the job when the claim
 * names one.
 */
export async function payExpenseReport(
  id: number, data: { paidOn: string; reference: string },
): Promise<{ error?: string }> {
  const u = await requireOwner();
  const [report] = await db.select().from(expenseReports).where(eq(expenseReports.id, id));
  if (!report) return { error: "Not found" };
  if (!houseOf(u, report.tenantOrgId)) return { error: "Not found" };
  if (report.status !== "submitted") return { error: `This report is ${report.status}, not awaiting payout` };
  const day = data.paidOn.trim();
  if (!isIsoDay(day)) return { error: "Pick the date it was paid" };
  if (day > shopToday()) return { error: "That date is in the future" };
  const rows = await db.select().from(expenses).where(eq(expenses.reportId, id));
  /* The gate the flag exists for. A row the travel rules queried cannot be
     paid until a person has said so on the record. */
  const unapproved = rows.filter(needsApproval);
  if (unapproved.length) {
    return {
      error: `${unapproved.length} row${unapproved.length === 1 ? "" : "s"} on this report `
        + `${unapproved.length === 1 ? "is" : "are"} outside the travel rules and `
        + `${unapproved.length === 1 ? "has" : "have"} not been approved. Open the report and approve `
        + `${unapproved.length === 1 ? "it" : "them"}, or send it back.`,
    };
  }
  const total = reportTotalCents(rows);
  const paidRef = data.reference.trim().slice(0, 120);
  const paid = { ...report, status: "paid", paidOn: day, paidBy: u.email, paidRef };
  const [wo] = report.workOrderId === null ? [null]
    : await db.select({ orgId: workOrders.orgId }).from(workOrders).where(eq(workOrders.id, report.workOrderId));
  try {
    await postReportPaid({ report: paid, cents: total, orgId: wo?.orgId ?? report.orgId, by: u.email });
  } catch (e) { return ledgerRefusal(e); }
  await db.update(expenseReports).set({ status: "paid", paidOn: day, paidBy: u.email, paidRef })
    .where(and(eq(expenseReports.id, id), eq(expenseReports.tenantOrgId, report.tenantOrgId as number)));
  await audit({
    actor: u.email, entityType: "expense_report", entityId: id, tenantOrgId: report.tenantOrgId,
    action: `paid ${report.person} ${formatCents(total)} for ${rows.length} expense${rows.length === 1 ? "" : "s"}`
      + (paidRef ? ` (${paidRef})` : "") + `, ${day}`,
  });
  revalidatePath("/money/reimbursements");
  revalidatePath(`/money/reimbursements/${id}`);
  revMoney();
  return {};
}

/**
 * Money the business spent that no job caused - an engineer's internet bill,
 * a software seat, the shop's own postage. Overhead never reaches an invoice
 * draft and never joins a job's margin.
 *
 * `person` is who gets reimbursed. With a name on it the money has not left
 * the company yet - it leaves when their claim is paid - so only a row with
 * nobody to reimburse posts here: overhead up, bank down.
 */
export async function logOverheadExpense(
  data: { kind: string; description: string; amount: string; incurredOn: string; person: string },
): Promise<{ error?: string }> {
  const u = await requireStaff();
  const cents = parseMoney(data.amount);
  if (cents === null || cents <= 0) return { error: "Enter an amount like 43.00" };
  const date = data.incurredOn.trim();
  if (!isIsoDay(date)) return { error: "Pick the date it was incurred" };
  const description = data.description.trim();
  if (!description) return { error: "Say what it was - a bare amount is unreadable in a month" };
  const person = data.person.trim();
  if (person && !(await assignableNames(u)).has(person)) return { error: "Unknown person" };
  // Stamped with the writer's own workspace, not readTenant(): for the
  // platform's own operator that reads null, and a null-stamped row is a
  // dollar the operator's ledger cannot see.
  const mine = myTenantOrgId(u);
  const kind = await cleanExpenseKind(data.kind, mine);
  const [row] = await db.insert(expenses).values({
    tenantOrgId: mine, workOrderId: null,
    kind, description, amountCents: cents,
    incurredOn: date, billable: false, person, loggedBy: u.email,
  }).returning();
  try {
    await postExpenseLogged({ expense: row, by: u.email });
  } catch (e) {
    await db.delete(expenses).where(and(eq(expenses.id, row.id), eq(expenses.tenantOrgId, row.tenantOrgId as number)));
    return ledgerRefusal(e);
  }
  await audit({
    actor: u.email, entityType: "expense", entityId: row.id, tenantOrgId: row.tenantOrgId,
    action: `logged ${formatCents(cents)} of overhead - ${description}${person ? ` (${person})` : ""}`,
  });
  revalidatePath("/money/expenses");
  revMoney();
  return {};
}

/**
 * The vendor was paid. NEW: a received order was a payable with nowhere to
 * say it had been settled, so Payables read high forever. Payable down, bank
 * down, for what the received lines came to.
 */
export async function payPurchaseOrder(
  poId: number, data: { paidOn: string; reference: string },
): Promise<{ error?: string }> {
  const u = await requireOwner();
  const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.id, poId));
  if (!po || !houseOf(u, po.tenantOrgId)) return { error: "Not found" };
  if (po.paidOn) return { error: `${po.number} was paid on ${po.paidOn}.` };
  if (po.status !== "received" && po.status !== "partial") {
    return { error: `${po.number} has not been received - there is nothing to pay for yet.` };
  }
  const day = data.paidOn.trim();
  if (!isIsoDay(day)) return { error: "Pick the date it was paid" };
  if (day > shopToday()) return { error: "That date is in the future" };
  const lines = await db.select().from(poLines).where(eq(poLines.poId, poId));
  // What is owed is what ARRIVED at the agreed price - the same figure the
  // receipt posted to Payable, so the two net to zero.
  const cents = lines.reduce((n, l) => n + (l.unitCents ?? 0) * l.qtyReceived, 0);
  if (cents <= 0) return { error: "Nothing has a price on this order, so nothing is owed." };
  try {
    await postPoPaid({ po, cents, on: day, by: u.email });
  } catch (e) { return ledgerRefusal(e); }
  const paidRef = data.reference.trim().slice(0, 120);
  await db.update(purchaseOrders).set({ paidOn: day, paidBy: u.email, paidRef })
    .where(and(eq(purchaseOrders.id, poId), eq(purchaseOrders.tenantOrgId, po.tenantOrgId as number)));
  await audit({
    actor: u.email, entityType: "po", entityId: poId, tenantOrgId: po.tenantOrgId,
    action: `paid ${po.vendor} ${formatCents(cents)} for ${po.number}${paidRef ? ` (${paidRef})` : ""}, ${day}`
      + ` - ${poTotals(lines).cents === cents ? "in full" : "for what has arrived"}`,
  });
  revalidatePath("/money/purchasing");
  revalidatePath(`/money/purchasing/${poId}`);
  revMoney();
  return {};
}

/**
 * Run a month's payroll. NEW: payroll was a register, not a run, so the
 * ledger had no day the wages left. One row per month by the unique index,
 * at the register's gross for that month; payroll cost up, bank down.
 */
export async function runPayroll(ym: string): Promise<{ error?: string; grossCents?: number }> {
  const u = await requireOwner();
  const mine = myTenantOrgId(u);
  if (mine === null) return { error: "Your company is not set up" };
  if (!mayEditPayroll(await payrollViewerFor(u), mine)) return { error: "Not found" };
  if (!/^\d{4}-\d{2}$/.test(ym)) return { error: "Pick a month, like 2026-09." };
  const today = shopToday();
  if (ym > today.slice(0, 7)) return { error: "That month has not started." };
  const [already] = await db.select().from(payrollRuns)
    .where(and(eq(payrollRuns.tenantOrgId, mine), eq(payrollRuns.ym, ym)));
  if (already) return { error: `${monthWord(ym)} was run on ${already.postedOn}.` };
  const rows = (await db.select().from(payroll).where(eq(payroll.orgId, mine))) as PayRow[];
  const gross = payrollForMonth(rows, ym).totalCents;
  if (gross <= 0) return { error: `Nobody is on the register for ${monthWord(ym)}.` };
  try {
    await postPayrollRun({ tenantOrgId: mine, ym, grossCents: gross, on: today, by: u.email });
  } catch (e) { return ledgerRefusal(e); }
  await db.insert(payrollRuns).values({ tenantOrgId: mine, ym, grossCents: gross, postedOn: today, postedBy: u.email });
  await audit({
    actor: u.email, entityType: "payroll", entityId: ym, tenantOrgId: mine,
    action: `ran ${monthWord(ym)} payroll: ${formatCents(gross)} gross`,
  });
  revalidatePath("/money/payroll");
  revMoney();
  return { grossCents: gross };
}

/** Sales tax paid to the state for a period: the liability down, bank down. */
export async function remitTax(data: { period: string; paidOn: string }): Promise<{ error?: string; cents?: number }> {
  const u = await requireOwner();
  const mine = myTenantOrgId(u);
  if (mine === null) return { error: "Your company is not set up" };
  const period = data.period.trim().slice(0, 40);
  if (!period) return { error: "Name the period, like 2026-Q3." };
  const day = data.paidOn.trim();
  if (!isIsoDay(day)) return { error: "Pick the date it was remitted" };
  const owed = await sumAccount("sales_tax_owed", { tenant: mine });
  if (owed <= 0) return { error: "No sales tax is owed." };
  try {
    await postTaxRemit({ tenantOrgId: mine, period, cents: owed, on: day, by: u.email });
  } catch (e) { return ledgerRefusal(e); }
  await audit({
    actor: u.email, entityType: "tax", entityId: period, tenantOrgId: mine,
    action: `remitted ${formatCents(owed)} of sales tax for ${period}, ${day}`,
  });
  revMoney();
  return { cents: owed };
}

// ---------------- The journal itself ----------------

/**
 * Reverse one entry from the ledger page. Owner only; the mirror is dated
 * today and carries the reason. A payment's entry takes the payment row with
 * it, the way deletePayment does, so the invoice and the ledger agree.
 */
export async function reverseLedgerEntry(entryId: number, reason: string): Promise<{ error?: string }> {
  const u = await requireOwner();
  const why = requireReason(reason);
  if (typeof why !== "string") return why;
  const [entry] = await db.select().from(ledgerEntries).where(eq(ledgerEntries.id, entryId));
  if (!entry || !houseOf(u, entry.tenantOrgId)) return { error: "Not found" };
  const payment = /^invoice:\d+:payment:(\d+)$/.exec(entry.postingKey);
  if (payment) return deletePayment(Number(payment[1]), why);
  try {
    await reverse({ entryId, reason: why, postedBy: u.email, today: shopToday() });
  } catch (e) { return ledgerRefusal(e); }
  await audit({
    actor: u.email, entityType: "ledger", entityId: entryId, tenantOrgId: entry.tenantOrgId,
    action: `reversed ledger entry #${entryId} (${entry.memo}) - reason: ${why}`,
    field: "reason", newValue: why,
  });
  revMoney();
  return {};
}

/** Close the books through a month, or reopen by naming an earlier one (blank = nothing closed). */
export async function closeBooks(ym: string): Promise<{ error?: string; was?: string }> {
  const u = await requireOwner();
  const mine = myTenantOrgId(u);
  if (mine === null) return { error: "Your company is not set up" };
  const month = ym.trim();
  const today = shopToday();
  const problem = closeProblem(month, today);
  if (problem) return { error: problem };
  const { was } = await closeBooksThrough(month, today);
  await audit({
    actor: u.email, entityType: "ledger", entityId: "close", tenantOrgId: mine,
    action: month
      ? `closed the books through ${monthWord(month)}${was ? ` (was ${monthWord(was)})` : ""}`
      : `reopened the books${was ? ` (were closed through ${monthWord(was)})` : ""}`,
    field: "books_closed_through", oldValue: was, newValue: month,
  });
  revMoney();
  return { was };
}

// ---------------- Parity ----------------

/**
 * Run the ledger parity check now and store it, as the hourly cron does.
 * Owner of a workspace: it reads every operator, the way the cron does, but
 * the page only ever shows the caller their own.
 */
export async function runLedgerParity(): Promise<{ error?: string; nonzero?: number }> {
  const u = await requireOwner();
  const mine = myTenantOrgId(u);
  if (mine === null) return { error: "Your company is not set up" };
  const { recordParity } = await import("@/lib/ledger/parity");
  const runs = await recordParity(shopToday());
  const own = runs.find((r) => r.tenantOrgId === mine);
  revalidatePath("/parity/ledger");
  return { nonzero: own?.figures.filter((f) => f.diffCents !== 0).length ?? 0 };
}
