"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { recordHistoricalInvoice, recordHistoricalQuote } from "@/app/actions";
import { formatCents } from "@/lib/money";
import { backfillTotal, invoiceProblem, quoteProblem, usableLines } from "@/lib/backfill";
import type { ClientOption } from "@/components/NewMoneyButtons";

type Row = { description: string; qty: string; price: string };
const blankRow = (): Row => ({ description: "", qty: "1", price: "" });

const cents = (s: string) => {
  const n = parseFloat(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const qtyOf = (s: string) => {
  const n = parseFloat(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : 1;
};

const INVOICE_OUTCOMES: [string, string][] = [
  ["paid", "Paid"], ["open", "Still open"], ["void", "Voided"],
];
const QUOTE_OUTCOMES: [string, string][] = [
  ["approved", "Approved"], ["declined", "Declined"], ["expired", "Expired unanswered"],
];
const METHODS: [string, string][] = [
  ["check", "Check"], ["ach", "ACH"], ["card", "Card"], ["other", "Other"],
];

/**
 * Paper that was already resolved before this app existed.
 *
 * Everything else in Money walks a document through its life, because that is
 * what the app is for. History has no life left to walk: last March's invoice
 * was issued in March and paid in April, and the only useful thing to do with
 * it now is write down what happened. Drafting it, "sending" it - mailing a
 * client a bill they settled a year ago - and then recording a payment dated
 * today is not a migration path, it is a hazard.
 *
 * So this door writes the finished state, and is defined by what it does NOT
 * do: nothing is emailed, no share link is minted, no card is charged, no
 * deposit invoice is raised, and no dunning ladder starts. The dialog says so
 * out loud, because somebody typing in a year of paper deserves to know that
 * none of it is going to reach the client.
 */
export default function BackfillButton({ kind, clients, today }: {
  kind: "invoice" | "quote";
  clients: ClientOption[];
  today: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [orgId, setOrgId] = useState(0);
  const [number, setNumber] = useState("");
  const [title, setTitle] = useState("");
  const [issuedOn, setIssuedOn] = useState("");
  const [answeredOn, setAnsweredOn] = useState("");
  const [outcome, setOutcome] = useState(kind === "invoice" ? "paid" : "approved");
  const [method, setMethod] = useState("check");
  const [reference, setReference] = useState("");
  const [rows, setRows] = useState<Row[]>([blankRow()]);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const isInvoice = kind === "invoice";
  const lines = rows.map((r) => ({
    kind: "part", description: r.description, qty: qtyOf(r.qty), unitCents: cents(r.price),
  }));
  const priced = usableLines(lines);
  const total = backfillTotal(priced);

  // The same rules the action applies, from the same file - so the dialog
  // never lets through something the server is about to refuse, and never
  // refuses something the server would have taken.
  const problem = !orgId ? "pick the client"
    : (isInvoice
      ? invoiceProblem({ issuedOn, outcome, paidOn: answeredOn, lines }, today)
      : quoteProblem({ title, sentOn: issuedOn, answeredOn, lines }, today)) || null;

  const reset = () => {
    setOrgId(0); setNumber(""); setTitle(""); setIssuedOn(""); setAnsweredOn("");
    setOutcome(isInvoice ? "paid" : "approved"); setMethod("check"); setReference("");
    setRows([blankRow()]); setError("");
  };

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows((s) => s.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const save = () => {
    if (problem) return;
    setError("");
    startTransition(async () => {
      const res = isInvoice
        ? await recordHistoricalInvoice(orgId, {
          number, issuedOn, dueOn: "", poNumber: "", note: "", lines, outcome,
          paidOn: answeredOn, method, reference,
        })
        : await recordHistoricalQuote(orgId, {
          number, title, sentOn: issuedOn, answeredOn, lines, outcome,
          answeredBy: "", answerNote: "",
        });
      if (res.error || !res.id) { setError(res.error ?? "That didn't save"); return; }
      toast({ message: `Recorded ${res.number} from the old records - nothing was sent` });
      setOpen(false);
      router.push(`/money/${isInvoice ? "invoices" : "quotes"}/${res.id}`);
    });
  };

  return (
    <>
      <button className="btn sm" onClick={() => { reset(); setOpen(true); }}>
        ＋ Historical
      </button>
      <Dialog open={open} onClose={() => setOpen(false)} size="md"
        title={isInvoice ? "Record a past invoice" : "Record a past quote"}
        context="Already resolved elsewhere - nothing here is sent, charged or chased"
        footer={
          <>
            <DialogStatus error={error} problem={problem}
              ok={total > 0 ? `${formatCents(total)} across ${priced.length} line${priced.length === 1 ? "" : "s"}` : undefined} />
            <button className="btn" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
            <button className="btn accent" onClick={save} disabled={pending || !!problem}>
              {pending ? "Recording..." : "Record it"}
            </button>
          </>
        }>
        <div className="dialog-section">Whose, and which one</div>
        <div className="pf2" style={{ marginBottom: 8 }}>
          <div>
            <label>Client</label>
            <select value={orgId || ""} aria-label="Client" autoFocus
              onChange={(e) => setOrgId(parseInt(e.target.value) || 0)}>
              <option value="">Pick the client</option>
              {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div>
            <label>Their number</label>
            {/* Their numbering, not ours: a migration whose numbers do not
                match the client's own records makes every future conversation
                about an old bill harder than it needs to be. */}
            <input value={number} aria-label="Document number" className="mono"
              placeholder="leave blank for the next in our sequence"
              onChange={(e) => setNumber(e.target.value)} />
          </div>
        </div>
        {!isInvoice && (
          <>
            <label>What it was for</label>
            <input value={title} aria-label="What it was for" placeholder="Relocate the GC-2010 to lab 4"
              onChange={(e) => setTitle(e.target.value)} style={{ marginBottom: 8 }} />
          </>
        )}

        <div className="dialog-section">What happened</div>
        <div className="pf2" style={{ marginBottom: 8 }}>
          <div>
            <label>{isInvoice ? "Issued" : "Sent"}</label>
            <input type="date" value={issuedOn} max={today} aria-label={isInvoice ? "Issued on" : "Sent on"}
              onChange={(e) => setIssuedOn(e.target.value)} />
          </div>
          <div>
            <label>Outcome</label>
            <select value={outcome} aria-label="Outcome" onChange={(e) => setOutcome(e.target.value)}>
              {(isInvoice ? INVOICE_OUTCOMES : QUOTE_OUTCOMES).map(([v, l]) =>
                <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
        </div>
        {(isInvoice ? outcome === "paid" : true) && (
          <div className="pf2" style={{ marginBottom: 8 }}>
            <div>
              <label>{isInvoice ? "Money arrived" : "They answered"}</label>
              <input type="date" value={answeredOn} min={issuedOn || undefined} max={today}
                aria-label={isInvoice ? "Paid on" : "Answered on"}
                onChange={(e) => setAnsweredOn(e.target.value)} />
              {isInvoice && !answeredOn && (
                <div className="field-hint">Blank records it as paid the day it was issued.</div>
              )}
            </div>
            {isInvoice && (
              <div>
                <label>How</label>
                <select value={method} aria-label="Payment method" onChange={(e) => setMethod(e.target.value)}>
                  {METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
            )}
          </div>
        )}
        {isInvoice && outcome === "paid" && (
          <>
            <label>Reference</label>
            <input value={reference} aria-label="Payment reference" className="mono" placeholder="check 10428"
              onChange={(e) => setReference(e.target.value)} style={{ marginBottom: 8 }} />
          </>
        )}

        <div className="dialog-section">Lines</div>
        {rows.map((r, i) => (
          <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6, alignItems: "flex-end" }}>
            <div style={{ flex: "1 1 160px", minWidth: 0 }}>
              {i === 0 && <label>What was billed</label>}
              <input value={r.description} aria-label={`Line ${i + 1} description`}
                placeholder="Quarterly PM, GC-2010"
                onChange={(e) => setRow(i, { description: e.target.value })} />
            </div>
            <div style={{ width: 64 }}>
              {i === 0 && <label>Qty</label>}
              <input value={r.qty} aria-label={`Line ${i + 1} quantity`} inputMode="decimal"
                onChange={(e) => setRow(i, { qty: e.target.value })} />
            </div>
            <div style={{ width: 100 }}>
              {i === 0 && <label>Each ($)</label>}
              <input value={r.price} aria-label={`Line ${i + 1} price`} inputMode="decimal" placeholder="0.00"
                onChange={(e) => setRow(i, { price: e.target.value })} />
            </div>
            <button className="btn link" style={{ color: "var(--t-bad-fg)", paddingBottom: 8 }}
              aria-label={`Remove line ${i + 1}`} disabled={rows.length === 1}
              onClick={() => setRows((s) => s.filter((_, idx) => idx !== i))}>×</button>
          </div>
        ))}
        <button className="btn sm" onClick={() => setRows((s) => [...s, blankRow()])}>＋ Line</button>
        <div className="field-hint" style={{ marginTop: 8 }}>
          Nothing here is emailed to the client, no payment link is minted, and a
          past-due one will not start a dunning ladder. It is a record, not a document
          this system issued - and the history line on it will say so.
        </div>
      </Dialog>
    </>
  );
}
