"use client";

import { useState, useTransition } from "react";
import { confirmDialog, confirmReason } from "@/components/ui/ConfirmDialog";
import PartNumberField from "./PartNumberField";
import {
  addPoLine, cancelPurchaseOrder, deletePoLine, deletePurchaseOrder, receivePoLine, sendPurchaseOrder, setPoLine, updatePurchaseOrder,
} from "@/app/actions";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { formatCents, centsToInput } from "@/lib/money";
import { PO_LABEL, PO_TONE, lineOutstanding, lineTotalCents, poEditable, poReceivable, poTotals } from "@/lib/po";
import { toast } from "@/components/ui/Toast";

export type PoRow = {
  id: number; number: string; vendor: string; status: string; reference: string; note: string;
  expectedAt: string; roomName: string; when: string; sentWhen: string; cancelReason: string;
};
export type PoLineRow = {
  id: number; partNumber: string; name: string; qtyOrdered: number; qtyReceived: number;
  unitCents: number | null; note: string;
};

export default function PoPanel({ po, lines, canManage, canDelete = false, makers }: {
  po: PoRow; lines: PoLineRow[]; canManage: boolean;
  /** Owners only: deleting an order is not the same power as running one. */
  canDelete?: boolean;
  /** The maker/vendor book (Settings → Catalog), suggested on the Vendor field. */
  makers?: string[];
}) {
  const editable = canManage && poEditable(po.status);
  const receivable = canManage && poReceivable(po.status);
  const [head, setHead] = useState({ vendor: po.vendor, reference: po.reference, note: po.note, expectedAt: po.expectedAt });
  const [editing, setEditing] = useState(false);
  const [newLine, setNewLine] = useState({ partNumber: "", name: "", qty: "1", price: "" });
  const [adding, setAdding] = useState(false);
  const [receiving, setReceiving] = useState<null | { id: number; qty: string; note: string }>(null);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const totals = poTotals(lines);
  const run = (fn: () => Promise<{ error?: string }>, after?: () => void) =>
    startTransition(async () => {
      const res = await fn();
      if (res?.error) setError(res.error);
      else { setError(""); after?.(); }
    });

  return (
    <>
      <div className="card">
        {/* Identity lives in the page's RecordHero now; this row is the order's controls. */}
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
          <div className="card-title">Lines</div>
          <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
            {editable && (
              <>
                <button className="btn sm" onClick={() => setEditing(!editing)}>{editing ? "Cancel" : "Edit"}</button>
                <button className="btn sm accent" disabled={pending || !lines.length}
                  onClick={async () => {
                    if (!(await confirmDialog({
                      title: `Send ${po.number} to ${po.vendor}?`,
                      body: "Lines lock after this.",
                      action: `Send ${po.number}`,
                    }))) return;
                    run(() => sendPurchaseOrder(po.id), () => toast({ message: `Sent ${po.number} to ${po.vendor}` }));
                  }}>Send to vendor</button>
              </>
            )}
          </span>
        </div>

        <div className="mut t-small" style={{ marginBottom: 8 }}>
          Raised {po.when}
          {po.sentWhen ? ` · sent ${po.sentWhen}` : ""}
          {po.expectedAt ? ` · expected ${po.expectedAt}` : ""}
          {po.reference ? ` · ref ${po.reference}` : ""}
        </div>
        {po.note && <div className="t-small" style={{ marginBottom: 8 }}>{po.note}</div>}
        {po.status === "cancelled" && po.cancelReason && (
          <div className="t-small" style={{ color: "var(--t-warn-fg)", background: "#FAF0DC", border: "1px solid #F0C9A0", borderRadius: 8, padding: "8px 12px", marginBottom: 8 }}>
            Cancelled: {po.cancelReason}. Anything already received stayed on the shelf.
          </div>
        )}

        {editing && (() => {
          const problem = !head.vendor.trim() ? "name the vendor" : null;
          return (
            <Dialog open onClose={() => setEditing(false)} title={`Edit ${po.number}`}
              context={`${po.vendor} · raised ${po.when}`}
              footer={
                <>
                  <DialogStatus error={error} problem={problem} />
                  <button className="btn" onClick={() => setEditing(false)} disabled={pending}>Cancel</button>
                  <button className="btn accent" disabled={pending || !!problem}
                    onClick={() => run(() => updatePurchaseOrder(po.id, head), () => { setEditing(false); toast({ message: `Saved ${po.number}` }); })}>
                    {pending ? "Saving..." : `Save ${po.number}`}
                  </button>
                </>
              }>
              <div className="dialog-section">Vendor and reference</div>
              <div className="pf2" style={{ marginBottom: 8 }}>
                <div><label>Vendor *</label><input value={head.vendor} list="maker-book" onChange={(e) => setHead({ ...head, vendor: e.target.value })} />
                  <datalist id="maker-book">{(makers ?? []).map((m) => <option key={m} value={m} />)}</datalist></div>
                <div><label>Reference</label><input value={head.reference} onChange={(e) => setHead({ ...head, reference: e.target.value })} placeholder="Vendor quote #" /></div>
                <div><label>Expected</label><input value={head.expectedAt} onChange={(e) => setHead({ ...head, expectedAt: e.target.value })} placeholder="Jul 23" /></div>
              </div>
              <div className="dialog-section">Note</div>
              <div style={{ marginBottom: 8 }}>
                <input value={head.note} onChange={(e) => setHead({ ...head, note: e.target.value })} aria-label="Note" />
              </div>
            </Dialog>
          );
        })()}

        {lines.map((l) => {
          const out = lineOutstanding(l);
          const total = lineTotalCents(l);
          const isReceiving = receiving?.id === l.id;
          return (
            <div key={l.id} style={{ borderTop: "1px solid var(--line)", padding: "7px 0" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <span className="mono t-body" style={{ fontWeight: 700 }}>{l.partNumber}</span>
                {l.name && <span className="t-body">{l.name}</span>}
                <span className="mut t-small">× {l.qtyOrdered}</span>
                {l.unitCents !== null
                  ? <span className="mut t-small">{formatCents(l.unitCents)} ea · {formatCents(total!)}</span>
                  : <span className="t-small" style={{ color: "var(--t-warn-fg)" }}>unpriced</span>}
                {l.qtyReceived > 0 && (
                  <span className={`pill ${out === 0 ? "good" : "warn"}`}>{l.qtyReceived} received{out > 0 ? `, ${out} to come` : ""}</span>
                )}
                <span style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
                  {receivable && out > 0 && (
                    <button className="btn link" style={{ fontSize: 12, fontWeight: 700 }}
                      onClick={() => { setError(""); setReceiving(isReceiving ? null : { id: l.id, qty: String(out), note: "" }); }}>
                      receive
                    </button>
                  )}
                  {editable && (
                    <button className="btn link" style={{ color: "var(--t-bad-fg)", fontSize: 12 }} disabled={pending}
                      onClick={() => run(() => deletePoLine(l.id))}>remove</button>
                  )}
                </span>
              </div>
              {l.note && <div className="mut t-small">{l.note}</div>}

              {editable && (
                <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap", alignItems: "center" }}>
                  <span className="mut t-meta">qty</span>
                  <input defaultValue={String(l.qtyOrdered)} inputMode="numeric" aria-label={`Quantity for ${l.partNumber}`}
                    onBlur={(e) => {
                      if (e.target.value.trim() === String(l.qtyOrdered)) return;
                      run(() => setPoLine(l.id, { qty: e.target.value, price: l.unitCents === null ? "" : centsToInput(l.unitCents) }));
                    }}
                    className="t-small" style={{ width: 60 }} />
                  <span className="mut t-meta">unit $</span>
                  <input defaultValue={l.unitCents === null ? "" : centsToInput(l.unitCents)} aria-label={`Unit price for ${l.partNumber}`}
                    placeholder="129.95"
                    onBlur={(e) => {
                      const was = l.unitCents === null ? "" : centsToInput(l.unitCents);
                      if (e.target.value.trim() === was) return;
                      run(() => setPoLine(l.id, { qty: String(l.qtyOrdered), price: e.target.value }));
                    }}
                    className="t-small" style={{ width: 90 }} />
                </div>
              )}

              {isReceiving && (() => {
                const n = parseInt(receiving.qty, 10);
                const qtyOk = Number.isInteger(n) && n > 0;
                const problem = !qtyOk ? "how many arrived? whole numbers above zero"
                  : n > out ? `only ${out} are outstanding`
                  : null;
                return (
                  <Dialog open onClose={() => setReceiving(null)} size="sm"
                    title={`Receive ${l.partNumber}`}
                    context={`${po.number} · ${out} outstanding`}
                    footer={
                      <>
                        <DialogStatus error={error} problem={problem} />
                        <button className="btn" onClick={() => setReceiving(null)} disabled={pending}>Cancel</button>
                        <button className="btn accent" disabled={pending || !!problem}
                          onClick={() => run(() => receivePoLine(l.id, n, receiving.note), () => setReceiving(null))}>
                          {pending ? "Booking..." : qtyOk ? `Book in ${n}` : "Book in"}
                        </button>
                      </>
                    }>
                    <div className="dialog-section">How many</div>
                    <div className="row-2">
                      <input value={receiving.qty} onChange={(e) => setReceiving({ ...receiving, qty: e.target.value })}
                        inputMode="numeric" aria-label="How many arrived" style={{ width: 64, minHeight: 34, textAlign: "center" }} />
                      <span className="mut t-small">of {out}</span>
                    </div>
                    <div className="dialog-section">Note</div>
                    <input value={receiving.note} onChange={(e) => setReceiving({ ...receiving, note: e.target.value })}
                      placeholder="Packing slip / note" className="t-body" style={{ minHeight: 34 }} aria-label="Note" />
                  </Dialog>
                );
              })()}
            </div>
          );
        })}

        {lines.length === 0 && <div className="mut t-body">Nothing on this order yet.</div>}

        {editable && (adding ? (() => {
          const problem = !newLine.partNumber.trim() ? "enter a part number" : null;
          return (
          <Dialog open onClose={() => setAdding(false)} title={`Add a line to ${po.number}`}
            context={`${po.vendor} · ${lines.length} line${lines.length === 1 ? "" : "s"} so far`}
            footer={
              <>
                <DialogStatus error={error} problem={problem} />
                <button className="btn" onClick={() => setAdding(false)} disabled={pending}>Cancel</button>
                <button className="btn accent" disabled={pending || !!problem}
                  onClick={() => run(() => addPoLine(po.id, newLine), () => {
                    setAdding(false); setNewLine({ partNumber: "", name: "", qty: "1", price: "" });
                    toast({ message: `Added ${newLine.partNumber.trim()} to ${po.number}` });
                  })}>
                  {pending ? "Adding..." : `Add to ${po.number}`}
                </button>
              </>
            }>
            <div className="dialog-section">What it is</div>
            <div className="pf2" style={{ marginBottom: 8 }}>
              <div>
                <label>Part number *</label>
                {/* The one field where inserting a superseded number costs real
                    money: it becomes what somebody orders. */}
                <PartNumberField value={newLine.partNumber}
                  onChange={(partNumber) => setNewLine({ ...newLine, partNumber })}
                  onPick={(part) => setNewLine((l) => ({
                    ...l,
                    partNumber: part.partNumber,
                    name: l.name.trim() || part.name,
                    // The price book's best offer, so a line is priced the
                    // moment it is added rather than counted as unpriced and
                    // typed in from a browser tab.
                    price: l.price.trim() || (part.priceCents !== null ? centsToInput(part.priceCents) : ""),
                  }))} />
              </div>
              <div><label>Description</label>
                <PartNumberField value={newLine.name} insert="name" className="" ariaLabel="Line description"
                  placeholder="What it is"
                  onChange={(name) => setNewLine((l) => ({ ...l, name }))}
                  onPick={(part) => setNewLine((l) => ({
                    ...l, name: part.name || part.partNumber,
                    partNumber: l.partNumber.trim() || part.partNumber,
                    price: l.price.trim() || (part.priceCents !== null ? centsToInput(part.priceCents) : ""),
                  }))} /></div>
            </div>
            <div className="dialog-section">Quantity and price</div>
            <div className="pf2" style={{ marginBottom: 8 }}>
              <div><label>Qty</label><input value={newLine.qty} inputMode="numeric" onChange={(e) => setNewLine({ ...newLine, qty: e.target.value })} /></div>
              <div><label>Unit $</label><input value={newLine.price} onChange={(e) => setNewLine({ ...newLine, price: e.target.value })} placeholder="129.95" /></div>
            </div>
          </Dialog>
          );
        })() : (
          <button className="btn link" style={{ fontSize: 12, marginTop: 8 }} onClick={() => setAdding(true)}>+ add a line</button>
        ))}

        {lines.length > 0 && (
          <div className="t-small" style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 10, borderTop: "1px solid var(--line)", paddingTop: 8 }}>
            <span className="mut">
              {totals.received} of {totals.ordered} received
              {totals.unpriced ? ` · ${totals.unpriced} line${totals.unpriced === 1 ? "" : "s"} unpriced` : ""}
            </span>
            <b>{formatCents(totals.cents)}</b>
          </div>
        )}

        {canManage && po.status !== "cancelled" && po.status !== "received" && (
          <button className="btn link" style={{ color: "var(--t-bad-fg)", fontSize: 12, marginTop: 10, fontWeight: 700 }} disabled={pending}
            onClick={async () => {
              const why = await confirmReason({
                title: `Cancel ${po.number}?`,
                body: "Anything already received stays on the shelf.",
                action: "Cancel order", cancel: "Keep it", tone: "bad",
              });
              if (!why) return;
              run(() => cancelPurchaseOrder(po.id, why));
            }}>Cancel this order</button>
        )}
        {/* For the order raised by mistake, as opposed to one that was real
            and called off. Refused by the server once anything has been
            received - said here too, so nobody reaches for it first. */}
        {canDelete && (
          <button className="btn link" style={{ color: "var(--t-bad-fg)", fontSize: 12, marginTop: 10, marginLeft: 12, fontWeight: 700 }} disabled={pending}
            onClick={async () => {
              const why = await confirmReason({
                title: `Delete ${po.number}?`,
                body: totals.received > 0
                  ? `${totals.received} item${totals.received === 1 ? " is" : "s are"} already received against this order, so it cannot be deleted - cancel it instead.`
                  : "For an order raised by mistake. Its lines go with it; any file or part that names it keeps the paperwork and loses the link.",
                action: "Delete order", cancel: "Keep it", tone: "bad",
              });
              if (!why) return;
              run(() => deletePurchaseOrder(po.id, why), () => { window.location.href = "/purchasing"; });
            }}>Delete this order</button>
        )}
        {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}
      </div>
    </>
  );
}
