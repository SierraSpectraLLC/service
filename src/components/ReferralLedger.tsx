"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  payReferralFee, recomputeReferralFee, reportReferralBilling, waiveReferralFee,
} from "@/app/actions";
import {
  accruedCents, feeLine, feeStanding, outstandingCents, STANDING_LABEL,
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
export default function ReferralLedger({ earned, owed, today, canPay }: {
  earned: LedgerFee[]; owed: LedgerFee[]; today: string; canPay: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [waiving, setWaiving] = useState<number | null>(null);
  const [reporting, setReporting] = useState<number | null>(null);
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
      setWaiving(null); setReporting(null); setText("");
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
            {formatCents(outstandingCents(f) || accruedCents(f))}
          </b>
        </div>
        <div className="mut t-small">
          {feeLine(f, formatCents)}
          {f.kind === "percent" && f.endsOn ? ` · window to ${f.endsOn}` : ""}
        </div>
        {/* Said on the row, not in a footnote: a figure somebody typed and a
            figure summed from a ledger are different kinds of claim. */}
        {f.kind === "percent" && f.billedFrom === "reported" && (
          <div className="t-meta" style={{ color: "var(--t-warn-fg)" }}>
            That total was reported by {side === "earned" ? f.otherName : "you"}, not computed from invoices.
          </div>
        )}
        {f.note && <div className="mut t-meta">{f.note}</div>}

        <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
          {f.kind === "percent" && s !== "waived" && (
            <button className="btn sm" disabled={pending}
              onClick={() => run(() => recomputeReferralFee(f.id), "Recomputed from the invoices")}>
              Recompute
            </button>
          )}
          {side === "owed" && outstandingCents(f) > 0 && canPay && (
            <button className="btn accent" disabled={pending}
              onClick={() => run(() => payReferralFee(f.id, "card"), "")}>
              Pay {formatCents(outstandingCents(f))}
            </button>
          )}
          {side === "owed" && f.kind === "percent" && s !== "waived" && (
            <button className="btn link" style={{ fontSize: 12 }} disabled={pending}
              onClick={() => { setError(""); setText(""); setReporting(f.id); }}>
              report what you billed
            </button>
          )}
          {side === "earned" && s !== "waived" && s !== "settled" && (
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
        <Panel title="Referral fees you owe" count={owed.filter((f) => outstandingCents(f) > 0).length || undefined}
          hint="Paid straight to them - this platform never holds the money.">
          {owed.map((f) => row(f, "owed"))}
        </Panel>
      )}
      {earned.length > 0 && (
        <Panel title="Referral fees owed to you" count={earned.filter((f) => outstandingCents(f) > 0).length || undefined}
          hint="For clients you handed to another shop.">
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
