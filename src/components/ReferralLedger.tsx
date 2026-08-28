"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import Link from "next/link";
import {
  billReferralFee, linkFeeClient, payReferralFee, recomputeReferralFee,
  reportReferralBilling, waiveReferralFee,
} from "@/app/actions";
import {
  accruedCents, feeLine, feeOutstanding, feeStanding, STANDING_LABEL,
  type FeeStanding,
} from "@/lib/referral";
import type { LedgerFee } from "@/lib/referralData";
import { formatCents } from "@/lib/money";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { Panel, Pill } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

const TONE: Record<FeeStanding, "good" | "warn" | "info" | "faint"> = {
  due: "warn", accruing: "info", settled: "good", waived: "faint", closed: "faint",
};

/**
 * Referral fees, both directions.
 *
 * What each side may see is the whole point. The PAYER sees everything - it is
 * their money and their ledger the percentage is taken of. The PAYEE sees one
 * aggregate and never an invoice, so the row says where that aggregate came
 * from: computed from the payer's own invoices, or a figure they reported.
 * Those are different claims and the panel never prints them the same way.
 */
export default function ReferralLedger({ earned, owed, today, canPay, clients }: {
  earned: LedgerFee[]; owed: LedgerFee[]; today: string; canPay: boolean;
  /** The payer's own clients, for pointing a lead's fee at one. */
  clients: { id: number; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [waiving, setWaiving] = useState<number | null>(null);
  const [reporting, setReporting] = useState<number | null>(null);
  const [linking, setLinking] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");

  if (earned.length === 0 && owed.length === 0) return null;

  const run = (fn: () => Promise<{ error?: string; url?: string } | void>, ok: string) =>
    startTransition(async () => {
      setError("");
      const res = await fn();
      if (res && "error" in res && res.error) { setError(res.error); toast({ message: res.error }); return; }
      if (res && "url" in res && res.url) { window.location.href = res.url; return; }
      toast({ message: ok });
      setWaiving(null); setReporting(null); setLinking(null); setText("");
      router.refresh();
    });

  const row = (f: LedgerFee, side: "earned" | "owed") => {
    const s = feeStanding(f, today);
    return (
      <div key={f.id} style={{ padding: "9px 0", borderTop: "1px solid var(--line)" }}>
        <div className="row-2" style={{ alignItems: "baseline" }}>
          <span className="t-body" style={{ fontWeight: 600, flex: 1, minWidth: 0 }}>
            {f.clientName}
            <span className="mut t-meta">
              {side === "earned" ? ` · ${f.otherName} owes` : ` · owed to ${f.otherName}`}
            </span>
          </span>
          <Pill tone={TONE[s]}>{STANDING_LABEL[s]}</Pill>
          <b className="t-body" style={{ width: 92, textAlign: "right" }}>
            {formatCents(feeOutstanding(f) || accruedCents(f))}
          </b>
        </div>
        <div className="mut t-small">
          {feeLine(f, formatCents)}
          {/* A lead's fee and a handover's sit in one list and settle the same
              way, but they are not the same thing: one was a client somebody
              already serviced, the other a name and a telephone number. */}
          {f.leadId !== null ? " · from a lead" : ""}
          {f.invoice ? ` · invoiced as ${f.invoice.number}` : ""}
          {f.kind === "percent" && f.endsOn ? ` · window to ${f.endsOn}` : ""}
        </div>
        {/* Said on the row, not in a footnote: a figure somebody typed and a
            figure summed from a ledger are different kinds of claim. */}
        {f.kind === "percent" && f.billedFrom === "reported" && (
          <div className="t-meta" style={{ color: "var(--t-warn-fg)" }}>
            That total was reported by {side === "earned" ? f.otherName : "you"}, not computed from invoices.
          </div>
        )}
        {f.kind === "percent" && f.clientOrgId === null && f.billedFrom !== "reported" && (
          <div className="t-meta" style={{ color: "var(--t-warn-fg)" }}>
            {side === "owed"
              ? "Not measured against anything yet - point it at the client once you have signed them."
              : `Nothing counted yet: ${f.otherName} has not signed them up.`}
          </div>
        )}
        {f.note && <div className="mut t-meta">{f.note}</div>}

        <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
          {f.kind === "percent" && s !== "waived" && f.clientOrgId !== null && (
            <button className="btn sm" disabled={pending}
              onClick={() => run(() => recomputeReferralFee(f.id), "Recomputed from the invoices")}>
              Recompute
            </button>
          )}
          {/* A lead's fee arrives pointing at nobody - the winner had a phone
              number, not a client. Until they name one there is no ledger for
              the percentage to be taken of, so the button offers that instead
              of a Recompute that can only ever return zero. */}
          {side === "owed" && f.kind === "percent" && f.clientOrgId === null && s !== "waived" && (
            <button className="btn sm" disabled={pending || clients.length === 0}
              onClick={() => { setError(""); setText(""); setLinking(f.id); }}>
              Point it at a client
            </button>
          )}
          {side === "owed" && !f.invoice && feeOutstanding(f) > 0 && canPay && (
            <button className="btn accent" disabled={pending}
              onClick={() => run(() => payReferralFee(f.id, "card"), "")}>
              Pay {formatCents(feeOutstanding(f))}
            </button>
          )}
          {side === "owed" && f.kind === "percent" && s !== "waived" && (
            <button className="btn link" style={{ fontSize: 12 }} disabled={pending}
              onClick={() => { setError(""); setText(""); setReporting(f.id); }}>
              report what you billed
            </button>
          )}
          {/* On an invoice it becomes accounting: a number, a place in the
              ledger, a statement line, ageing, dunning, and the payer settles
              it the way they settle anything else. */}
          {side === "earned" && !f.invoice && s === "due" && (
            <button className="btn accent" disabled={pending}
              onClick={() => run(() => billReferralFee(f.id), "Drafted an invoice for it")}>
              Invoice it
            </button>
          )}
          {f.invoice && (
            <Link className="btn sm" style={{ textDecoration: "none" }}
              href={`/money/invoices/${f.invoice.id}`}>
              {f.invoice.number}
              {f.invoice.balanceCents <= 0 ? " · paid" : ` · ${formatCents(f.invoice.balanceCents)} open`}
            </Link>
          )}
          {side === "earned" && s !== "waived" && s !== "settled" && !f.invoice && (
            <button className="btn link" style={{ fontSize: 12 }} disabled={pending}
              onClick={() => { setError(""); setText(""); setWaiving(f.id); }}>
              waive it
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      {owed.length > 0 && (
        <Panel title="Referral fees you owe" count={owed.filter((f) => feeOutstanding(f) > 0).length || undefined}
          hint="Paid straight to them - this platform never holds the money.">
          {owed.map((f) => row(f, "owed"))}
        </Panel>
      )}
      {earned.length > 0 && (
        <Panel title="Referral fees owed to you" count={earned.filter((f) => feeOutstanding(f) > 0).length || undefined}
          hint="For clients you handed on, and leads you sold.">
          {earned.map((f) => row(f, "earned"))}
        </Panel>
      )}

      {waiving !== null && (
        <Dialog open onClose={() => setWaiving(null)} size="sm" title="Waive this fee"
          context="Yours to forgive. It stays on the record as waived rather than disappearing."
          footer={<>
            <DialogStatus error={error} problem={text.trim() ? null : "say why"} />
            <button className="btn" onClick={() => setWaiving(null)} disabled={pending}>Cancel</button>
            <button className="btn accent" disabled={pending || !text.trim()}
              onClick={() => run(() => waiveReferralFee(waiving, text), "Waived")}>Waive</button>
          </>}>
          <label>Why</label>
          <input value={text} aria-label="Why" autoFocus
            placeholder="they took it on as a favour to us"
            onChange={(e) => setText(e.target.value)} />
        </Dialog>
      )}

      {linking !== null && (
        <Dialog open onClose={() => setLinking(null)} size="sm"
          title="Which client is this?"
          context="The percentage is taken of what you bill them. Pick your own record for the lab you were referred to."
          footer={<>
            <DialogStatus error={error} problem={text ? null : "pick a client"} />
            <button className="btn" onClick={() => setLinking(null)} disabled={pending}>Cancel</button>
            <button className="btn accent" disabled={pending || !text}
              onClick={() => run(() => linkFeeClient(linking, Number(text)), "Pointed at that client")}>
              Use this one
            </button>
          </>}>
          <label>Client</label>
          <select value={text} aria-label="Client" onChange={(e) => setText(e.target.value)}>
            <option value="">Pick one</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Dialog>
      )}

      {reporting !== null && (
        <Dialog open onClose={() => setReporting(null)} size="sm"
          title="What you have billed them"
          context="For work invoiced outside Ridgeline. It is recorded as reported, not computed - and both of you see that it was."
          footer={<>
            <DialogStatus error={error} problem={text.trim() ? null : "give an amount"} />
            <button className="btn" onClick={() => setReporting(null)} disabled={pending}>Cancel</button>
            <button className="btn accent" disabled={pending || !text.trim()}
              onClick={() => run(() => reportReferralBilling(reporting, text), "Recorded")}>Record it</button>
          </>}>
          <label>Billed in the window, total</label>
          <input className="mono t-small" value={text} aria-label="Billed total" autoFocus
            placeholder="48000" onChange={(e) => setText(e.target.value)} />
        </Dialog>
      )}
    </>
  );
}
