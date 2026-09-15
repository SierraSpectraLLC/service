// What needs deciding, from every document that is waiting on somebody.
//
// The argument for the whole section in one list. Every item here was already
// visible somewhere before - an overdue invoice, an unanswered quote, a closed
// job, a claim on the desk, a bill due, a received order, a month of payroll -
// on seven pages, with nothing that put them in one place, ranked them, or
// put the button beside the row.
//
// ONE FUNCTION, TWO READERS. The Home page draws this list; the daily digest's
// money section is a projection of the same sources (digestInputFrom), so the
// email and the page cannot disagree about what is waiting. Pure: the loader
// in lib/money/figures hands in rows.

import { formatCents } from "@/lib/money";
import { CHASE_DAYS, daysBetween, daysFrom, plusDays, STALE_QUOTE_DAYS, UNBILLED_AFTER_DAYS_HOME } from "@/lib/money/constants";
import type { MoneyInput } from "@/lib/digestMoney";

export type DecisionTone = "bad" | "warn" | "";

/** What the button on the row does. Links open a page; posts post. */
export type DecisionAction =
  | { kind: "link"; href: string; label: string; primary?: boolean; accent?: boolean }
  | { kind: "send-invoice"; id: number; label: string }
  | { kind: "pay-po"; id: number; label: string }
  | { kind: "run-payroll"; ym: string; label: string }
  | { kind: "draft-invoice"; workOrderId: number; number: string; label: string };

export type Decision = {
  key: string;
  tone: DecisionTone;
  title: string;
  detail: string;
  cents: number;
  /** Where the row itself leads - the document. */
  href: string;
  action: DecisionAction;
};

export type DecisionSources = {
  today: string;
  drafts: { id: number; number: string; orgName: string; totalCents: number; workOrderId: number | null }[];
  overdue: {
    id: number; number: string; orgName: string; daysLate: number; balanceCents: number;
    promiseBroken: boolean; disputed: boolean;
  }[];
  unbilled: { woId: number; number: string; orgName: string; title: string; daysClosed: number; valueCents: number }[];
  reports: { id: number; person: string; title: string; status: string; cents: number; submittedOn: string }[];
  billsDue: { id: number; payee: string; kind: string; cents: number; on: string; portalUrl: string }[];
  posReceived: { id: number; number: string; vendor: string; title: string; cents: number; receivedOn: string }[];
  unmatchedBank: { count: number; cents: number };
  stripeCents: number;
  installments: { agreementId: number; orgName: string; title: string; cents: number; on: string }[];
  holds: { orgId: number; orgName: string; worstDays: number; owedCents: number }[];
  payroll: { ym: string; grossCents: number; runOn: string; people: number } | null;
  staleQuotes: { id: number; number: string; orgName: string; daysUnanswered: number; totalCents: number; daysLeft: number; views: number }[];
  brokenPromises: { number: string; orgName: string; byName: string; promisedOn: string; daysPast: number; payableCents: number }[];
  openDisputes: { number: string; orgName: string; reason: string; daysOpen: number; disputedCents: number; restCents: number }[];
};

const shortDate = (s: string) =>
  s ? new Date(`${s}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "";

/** Worst first, then biggest: the thing you can fix today goes on top. */
export function rankDecisions(list: Decision[]): Decision[] {
  const weight: Record<DecisionTone, number> = { bad: 0, warn: 1, "": 2 };
  return [...list].sort((a, b) => weight[a.tone] - weight[b.tone] || b.cents - a.cents);
}

export function decisionsFrom(s: DecisionSources): Decision[] {
  const out: Decision[] = [];
  const t = s.today;

  for (const d of s.drafts) {
    out.push({
      key: `draft-${d.id}`, tone: "", title: `Send ${d.number}`,
      detail: `${d.orgName} · drafted, nothing posted yet`, cents: d.totalCents,
      href: `/money/invoices/${d.id}`,
      action: { kind: "send-invoice", id: d.id, label: "Send" },
    });
  }
  for (const i of s.overdue) {
    out.push({
      key: `overdue-${i.id}`, tone: "bad",
      title: `${i.number} is ${i.daysLate} day${i.daysLate === 1 ? "" : "s"} past due`,
      detail: `${i.orgName}${i.promiseBroken ? " · promise broken" : ""}${i.disputed ? " · one line disputed" : ""}`
        + (i.daysLate >= CHASE_DAYS ? " · stopped being late and become a problem" : ""),
      cents: i.balanceCents, href: `/money/invoices/${i.id}`,
      action: i.disputed
        ? { kind: "link", href: `/money/invoices/${i.id}`, label: "Resolve dispute" }
        : { kind: "link", href: `/money/invoices/${i.id}`, label: "Send next rung", accent: true },
    });
  }
  for (const j of s.unbilled) {
    if (j.daysClosed < UNBILLED_AFTER_DAYS_HOME) continue;
    out.push({
      key: `unbilled-${j.woId}`, tone: "warn",
      title: `${j.number} closed ${j.daysClosed} day${j.daysClosed === 1 ? "" : "s"} ago, not billed`,
      detail: `${j.orgName} · ${j.title} · the leak`, cents: j.valueCents,
      href: `/work/${j.woId}`,
      action: { kind: "draft-invoice", workOrderId: j.woId, number: j.number, label: "Draft invoice" },
    });
  }
  for (const r of s.reports) {
    if (r.status !== "submitted") continue;
    out.push({
      key: `report-${r.id}`, tone: "",
      title: `${r.person} is waiting on ${r.title || "a claim"}`,
      detail: `submitted ${shortDate(r.submittedOn)} · approve, then pay`, cents: r.cents,
      href: `/money/reimbursements/${r.id}`,
      action: { kind: "link", href: `/money/reimbursements/${r.id}`, label: "Pay", primary: true },
    });
  }
  for (const b of s.billsDue) {
    const d = daysFrom(t, b.on);
    out.push({
      key: `bill-${b.id}-${b.on}`, tone: d < 0 ? "bad" : d <= 3 ? "warn" : "",
      title: `${b.payee} due ${d === 0 ? "today" : d < 0 ? `${-d} day${d === -1 ? "" : "s"} ago` : `in ${d} day${d === 1 ? "" : "s"}`}`,
      detail: `${b.kind} · ${formatCents(b.cents)} · posts to overhead on its day`, cents: b.cents,
      href: "/money/payables",
      action: { kind: "link", href: b.portalUrl || "/money/payables", label: b.portalUrl ? "Pay" : "Bills" },
    });
  }
  for (const p of s.posReceived) {
    out.push({
      key: `po-${p.id}`, tone: "",
      title: `Pay ${p.vendor} for ${p.number}`,
      detail: `${p.title} · received ${shortDate(p.receivedOn)}`, cents: p.cents,
      href: `/money/purchasing/${p.id}`,
      action: { kind: "pay-po", id: p.id, label: "Pay" },
    });
  }
  if (s.unmatchedBank.count > 0) {
    out.push({
      key: "bank-unmatched", tone: "warn",
      title: `${s.unmatchedBank.count} bank line${s.unmatchedBank.count === 1 ? " has" : "s have"} no entry`,
      detail: "the bank says money moved and the books do not - reconcile", cents: s.unmatchedBank.cents,
      href: "/money/cash",
      action: { kind: "link", href: "/money/cash", label: "Reconcile", primary: true },
    });
  }
  if (s.stripeCents > 0) {
    out.push({
      key: "stripe-balance", tone: "",
      title: `${formatCents(s.stripeCents)} sitting in Stripe`,
      detail: "collected by pay link, not yet in the bank", cents: s.stripeCents,
      href: "/money/cash",
      action: { kind: "link", href: "/money/cash", label: "Cash" },
    });
  }
  for (const a of s.installments) {
    if (daysFrom(t, a.on) > 21) continue;
    out.push({
      key: `installment-${a.agreementId}-${a.on}`, tone: "",
      title: `${a.orgName} installment due ${shortDate(a.on)}`,
      detail: `${a.title} · the next cycle, not yet drafted`, cents: a.cents,
      href: "/money/clients",
      action: { kind: "link", href: "/money/clients", label: "Contracts" },
    });
  }
  for (const h of s.holds) {
    out.push({
      key: `hold-${h.orgId}`, tone: "bad",
      title: `${h.orgName} is on credit hold`,
      detail: `${h.worstDays} days past due · new work cannot be scheduled without an override`, cents: h.owedCents,
      href: `/money/clients?org=${h.orgId}`,
      action: { kind: "link", href: `/money/clients?org=${h.orgId}`, label: "Review" },
    });
  }
  if (s.payroll) {
    out.push({
      key: `payroll-${s.payroll.ym}`, tone: "",
      title: `Payroll for ${monthWord(s.payroll.ym)} runs ${shortDate(s.payroll.runOn)}`,
      detail: `gross for ${s.payroll.people} ${s.payroll.people === 1 ? "person" : "people"} · ${formatCents(s.payroll.grossCents)}`,
      cents: s.payroll.grossCents, href: "/money/payroll",
      action: { kind: "run-payroll", ym: s.payroll.ym, label: "Run now" },
    });
  }
  for (const q of s.staleQuotes) {
    out.push({
      key: `quote-${q.id}`, tone: q.daysUnanswered >= STALE_QUOTE_DAYS ? "bad" : "warn",
      title: `${q.number} has been unanswered for ${q.daysUnanswered} day${q.daysUnanswered === 1 ? "" : "s"}`,
      detail: `${q.orgName} · ${q.daysLeft} day${q.daysLeft === 1 ? "" : "s"} before it expires · opened ${q.views} time${q.views === 1 ? "" : "s"}`,
      cents: q.totalCents, href: `/money/quotes/${q.id}`,
      action: { kind: "link", href: `/money/quotes/${q.id}`, label: "Nudge" },
    });
  }
  return rankDecisions(out);
}

/**
 * The digest's money section, from the same sources. It keeps its own
 * vocabulary (whose move) and its own renderer; what it can no longer do is
 * disagree with the page about what is waiting.
 */
export function digestInputFrom(s: DecisionSources): MoneyInput {
  return {
    unbilled: s.unbilled.map((j) => ({ number: j.number, orgName: j.orgName, daysClosed: j.daysClosed, valueCents: j.valueCents }))
      .filter((j) => j.valueCents > 0),
    brokenPromises: s.brokenPromises,
    openDisputes: s.openDisputes,
    overdue: s.overdue.map((i) => ({ number: i.number, orgName: i.orgName, daysLate: i.daysLate, balanceCents: i.balanceCents })),
    onHold: s.holds.map((h) => ({ orgName: h.orgName, balanceCents: h.owedCents, oldestDaysLate: h.worstDays })),
    staleQuotes: s.staleQuotes.map((q) => ({ number: q.number, orgName: q.orgName, daysLeft: q.daysLeft, valueCents: q.totalCents, views: q.views })),
  };
}

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const monthWord = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1] ?? ym} ${ym.slice(0, 4)}`;

export { daysBetween, plusDays };
