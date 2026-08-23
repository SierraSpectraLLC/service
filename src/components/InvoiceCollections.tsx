"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { confirmDialog, confirmReason } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { keepPromise, logPromise, openDispute, postFee, resolveDispute, waiveFee } from "@/app/actions";
import { formatCents } from "@/lib/money";
import { Panel, Pill } from "@/components/ui";

export type FeeRow = { id: number; amountCents: number; basis: string; postedOn: string; waived: boolean; waivedReason: string };
export type PromiseRow = { id: number; promisedOn: string; byName: string; note: string; keptOn: string | null };
export type DisputeRow = { id: number; lineId: number | null; lineLabel: string; reason: string; openedOn: string; resolvedOn: string | null; resolution: string };

/**
 * The three things that happen to a bill after it is sent and before it is
 * paid: a charge, a promise, and an argument.
 *
 * They live together because they are one conversation. A promise is what
 * somebody said instead of paying; a dispute is why part of it is not being
 * asked for; a fee is what the delay has cost. Reading them apart is how the
 * person on the phone ends up quoting the wrong number.
 */
export default function InvoiceCollections({
  invoiceId, number, today, canPostFee, feeHint, fees, promises, disputes, lines,
}: {
  invoiceId: number;
  number: string;
  today: string;
  canPostFee: boolean;
  /** Why no fee may be posted, when none may. */
  feeHint: string;
  fees: FeeRow[];
  promises: PromiseRow[];
  disputes: DisputeRow[];
  lines: { id: number; label: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [promise, setPromise] = useState({ promisedOn: today, byName: "", note: "" });
  const [showPromise, setShowPromise] = useState(false);
  const [dispute, setDispute] = useState({ lineId: "", reason: "" });
  const [showDispute, setShowDispute] = useState(false);
  const [error, setError] = useState("");

  const run = (fn: () => Promise<{ error?: string }>, ok: string) => startTransition(async () => {
    setError("");
    const res = await fn();
    if (res.error) { setError(res.error); toast({ message: res.error, tone: "bad" }); return; }
    toast({ message: ok });
    router.refresh();
  });

  const waive = async (f: FeeRow) => {
    const why = await confirmReason({
      title: `Waive the ${formatCents(f.amountCents)} fee?`,
      context: number,
      body: "The row stays and gets flagged. Expect to waive more than you charge - the record of having charged and then waived is the part worth keeping.",
      action: "Waive the fee",
    });
    if (!why) return;
    run(() => waiveFee(f.id, why), `Waived the ${formatCents(f.amountCents)} fee`);
  };

  const resolve = async (d: DisputeRow, how: "kept" | "credited") => {
    const ok = await confirmDialog({
      title: how === "credited" ? "Credit this line?" : "The line stands?",
      context: d.lineLabel || number,
      body: how === "credited"
        ? "A negative line is added rather than the disputed one being edited, so the invoice still reconciles against the copy in their inbox."
        : "The pause lifts and the full amount goes back to being asked for.",
      action: how === "credited" ? "Issue the credit" : "Keep the line",
    });
    if (!ok) return;
    run(() => resolveDispute(d.id, how, ""), how === "credited" ? "Credited the line" : "Kept the line");
  };

  return (
    <>
      <Panel
        title="Late fees"
        count={fees.length}
        actions={canPostFee
          ? <button className="btn sm" disabled={pending}
              onClick={() => run(async () => {
                const res = await postFee(invoiceId);
                return res.error ? { error: res.error } : {};
              }, "Posted the late fee")}>
              Post the fee
            </button>
          : undefined}
        hint={feeHint || "A fee is its own row and never edits the invoice it belongs to."}
        empty="No fee has been charged."
      >
        {fees.length > 0 && fees.map((f) => (
          <div key={f.id} className="row-2" style={{ alignItems: "baseline", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
            <b className="t-body" style={{ width: 80 }}>{formatCents(f.amountCents)}</b>
            {f.waived
              ? <Pill tone="faint">Waived</Pill>
              : <Pill tone="warn">Charged</Pill>}
            <span className="mut t-small" style={{ flex: 1, minWidth: 0 }}>
              {f.waived ? f.waivedReason : f.basis}
            </span>
            <span className="mut t-meta">{f.postedOn}</span>
            {!f.waived && (
              <button className="btn link t-meta" disabled={pending} onClick={() => waive(f)}>waive</button>
            )}
          </div>
        ))}
      </Panel>

      <Panel
        title="Promises"
        count={promises.length}
        actions={
          <button className="btn sm" disabled={pending} onClick={() => setShowPromise((v) => !v)}>
            Log a promise
          </button>
        }
        hint="The morning after one breaks is when the conversation changes - and the ladder skips a rung."
        empty="Nobody has promised anything."
      >
        {showPromise && (
          <div className="row-2" style={{ padding: "8px 0", borderTop: "1px solid var(--line)" }}>
            <input className="t-body" type="date" value={promise.promisedOn} aria-label="Day they said"
              onChange={(e) => setPromise({ ...promise, promisedOn: e.target.value })} />
            <input className="t-body" value={promise.byName} aria-label="Who said it" placeholder="Who said it"
              onChange={(e) => setPromise({ ...promise, byName: e.target.value })} />
            <input className="t-body" value={promise.note} aria-label="What they said" placeholder="What they said"
              style={{ flex: 1, minWidth: 140 }}
              onChange={(e) => setPromise({ ...promise, note: e.target.value })} />
            <button className="btn sm accent" disabled={pending || !promise.byName.trim()}
              onClick={() => run(() => logPromise(invoiceId, promise), `Logged ${promise.byName.trim()}'s promise`)}>
              Log it
            </button>
          </div>
        )}
        {promises.map((p) => {
          const broken = !p.keptOn && p.promisedOn < today;
          return (
            <div key={p.id} className="row-2" style={{ alignItems: "baseline", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
              <Pill tone={p.keptOn ? "good" : broken ? "bad" : "info"}>
                {p.keptOn ? "Kept" : broken ? "Broken" : "Promised"}
              </Pill>
              <span className="t-body" style={{ flex: 1, minWidth: 0 }}>
                {p.byName} by {p.promisedOn}
                {p.note && <span className="mut t-meta" style={{ display: "block" }}>{p.note}</span>}
              </span>
              {!p.keptOn && (
                <button className="btn link t-meta" disabled={pending}
                  onClick={() => run(() => keepPromise(p.id), "Marked the promise kept")}>
                  they paid
                </button>
              )}
            </div>
          );
        })}
      </Panel>

      <Panel
        title="Disputes"
        count={disputes.length}
        actions={
          <button className="btn sm" disabled={pending} onClick={() => setShowDispute((v) => !v)}>
            Log a dispute
          </button>
        }
        hint="A questioned line stops being asked for. The rest keeps aging, and reminders quote only that."
        empty="Nothing has been questioned."
      >
        {showDispute && (
          <div className="row-2" style={{ padding: "8px 0", borderTop: "1px solid var(--line)" }}>
            <select className="t-body" value={dispute.lineId} aria-label="Which line"
              onChange={(e) => setDispute({ ...dispute, lineId: e.target.value })}>
              <option value="">The invoice as a whole</option>
              {lines.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
            </select>
            <input className="t-body" value={dispute.reason} aria-label="What they said"
              placeholder="In their words" style={{ flex: 1, minWidth: 160 }}
              onChange={(e) => setDispute({ ...dispute, reason: e.target.value })} />
            <button className="btn sm accent" disabled={pending || dispute.reason.trim().length < 3}
              onClick={() => run(
                () => openDispute(invoiceId, { lineId: dispute.lineId ? Number(dispute.lineId) : null, reason: dispute.reason }),
                "Logged the dispute",
              )}>
              Log it
            </button>
          </div>
        )}
        {disputes.map((d) => (
          <div key={d.id} className="row-2" style={{ alignItems: "baseline", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
            <Pill tone={d.resolvedOn ? "neutral" : "warn"}>
              {d.resolvedOn ? (d.resolution === "credited" ? "Credited" : "Line stood") : "Open"}
            </Pill>
            <span className="t-body" style={{ flex: 1, minWidth: 0 }}>
              {d.lineLabel || "The invoice"}
              <span className="mut t-meta" style={{ display: "block" }}>{d.reason} · {d.openedOn}</span>
            </span>
            {!d.resolvedOn && (
              <>
                <button className="btn link t-meta" disabled={pending} onClick={() => resolve(d, "kept")}>
                  keep the line
                </button>
                <button className="btn link t-meta" disabled={pending} onClick={() => resolve(d, "credited")}>
                  credit it
                </button>
              </>
            )}
          </div>
        ))}
      </Panel>
      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)" }}>{error}</div>}
    </>
  );
}
