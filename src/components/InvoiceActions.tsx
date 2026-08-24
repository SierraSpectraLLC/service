"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { confirmDialog, confirmReason } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { deleteInvoice, recordPayment, sendInvoice, voidInvoice } from "@/app/actions";
import { PAYMENT_METHODS, METHOD_LABEL } from "@/lib/statement";
import { formatCents } from "@/lib/money";

/**
 * The three things somebody does to an invoice from its own page: issue it,
 * record what arrived, or void it.
 *
 * Sending is a confirm rather than a plain click because it is the moment the
 * bill leaves the building - and because the PO warning, if there is one, is
 * the last chance anybody has to read it.
 */
export default function InvoiceActions({ id, number, status, balanceCents, today, poWarning, canDelete = false }: {
  id: number;
  number: string;
  status: string;
  balanceCents: number;
  today: string;
  poWarning: string;
  canDelete?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [pay, setPay] = useState({ method: "check", amount: "", reference: "", receivedOn: today });
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState("");

  const send = async () => {
    const ok = await confirmDialog({
      title: `Send ${number}?`,
      body: poWarning || "The client gets a link to the invoice, and its open event becomes the Viewed line on this timeline.",
      action: "Send invoice",
    });
    if (!ok) return;
    startTransition(async () => {
      const res = await sendInvoice(id);
      if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
      toast({ message: res.warning || `Sent ${number}`, ...(res.warning ? { tone: "bad" as const } : {}) });
      router.refresh();
    });
  };

  const submitPayment = () => startTransition(async () => {
    setError("");
    const res = await recordPayment(id, pay);
    if (res.error) { setError(res.error); return; }
    toast({ message: `Recorded ${pay.amount} on ${number}` });
    setPay({ method: "check", amount: "", reference: "", receivedOn: today });
    setPaying(false);
    router.refresh();
  });

  const kill = async () => {
    const why = await confirmReason({
      title: `Void ${number}?`,
      body: "The number and its lines stay on the record - a missing invoice number is a gap somebody has to explain. Say why it is being voided.",
      action: "Void invoice",
      tone: "bad",
    });
    if (!why) return;
    startTransition(async () => {
      const res = await voidInvoice(id, why);
      if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
      toast({ message: `Voided ${number}` });
      router.refresh();
    });
  };

  return (
    <>
      <div className="row-2">
        {status === "draft" && (
          <button className="btn sm accent" disabled={pending} onClick={send}>Send invoice</button>
        )}
        {status !== "draft" && status !== "void" && balanceCents > 0 && (
          <button className="btn sm accent" disabled={pending} onClick={() => setPaying((v) => !v)}>
            Record payment
          </button>
        )}
        {status !== "void" && (
          <button className="btn sm" disabled={pending} onClick={kill}>Void</button>
        )}
        {canDelete && (
          <button className="btn sm danger" disabled={pending} onClick={async () => {
            const why = await confirmReason({
              title: `Delete ${number}?`,
              body: "Removes the invoice and everything on it - lines, fees, payments, links.",
              action: "Delete", tone: "bad",
            });
            if (!why) return;
            startTransition(async () => {
              const res = await deleteInvoice(id, why);
              if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
              toast({ message: `Deleted ${number}` });
              router.push("/money/invoices");
            });
          }}>Delete</button>
        )}
      </div>

      {paying && (
        <div className="card" style={{ marginTop: 10 }}>
          <div className="row-2" style={{ marginBottom: 8 }}>
            <select className="t-body" value={pay.method} aria-label="How it arrived"
              onChange={(e) => setPay({ ...pay, method: e.target.value })}>
              {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
            </select>
            <input className="t-body" value={pay.amount} inputMode="decimal" aria-label="Amount"
              placeholder={(balanceCents / 100).toFixed(2)} style={{ width: 110 }}
              onChange={(e) => setPay({ ...pay, amount: e.target.value })} />
            <input className="t-body" type="date" value={pay.receivedOn} max={today} aria-label="Date it arrived"
              onChange={(e) => setPay({ ...pay, receivedOn: e.target.value })} />
            <input className="t-body" value={pay.reference} aria-label="Reference"
              placeholder="Check number or reference" style={{ flex: 1, minWidth: 140 }}
              onChange={(e) => setPay({ ...pay, reference: e.target.value })} />
            <button className="btn sm accent" disabled={pending || !pay.amount.trim()} onClick={submitPayment}>
              Record
            </button>
          </div>
          <div className="mut t-small">
            {formatCents(balanceCents)} is open. A payment is never edited afterwards - a mistake is corrected by a second row.
          </div>
          {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 6 }}>{error}</div>}
        </div>
      )}
    </>
  );
}
