"use client";

import { useState, useTransition } from "react";
import { promptReason } from "@/lib/reason";
import PartNumberField from "./PartNumberField";
import {
  addPoLine, cancelPurchaseOrder, deletePoLine, receivePoLine, sendPurchaseOrder, setPoLine, updatePurchaseOrder,
} from "@/app/actions";
import { formatCents, centsToInput } from "@/lib/money";
import { PO_COLOR, PO_LABEL, lineOutstanding, lineTotalCents, poEditable, poReceivable, poTotals } from "@/lib/po";

export type PoRow = {
  id: number; number: string; vendor: string; status: string; reference: string; note: string;
  expectedAt: string; roomName: string; when: string; sentWhen: string; cancelReason: string;
};
export type PoLineRow = {
  id: number; partNumber: string; name: string; qtyOrdered: number; qtyReceived: number;
  unitCents: number | null; note: string;
};

export default function PoPanel({ po, lines, canManage, makers }: {
  po: PoRow; lines: PoLineRow[]; canManage: boolean;
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
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
          <div className="card-title">{po.number}</div>
          <span className="pill" style={{ background: PO_COLOR[po.status]?.bg, color: PO_COLOR[po.status]?.fg, fontWeight: 700 }}>
            {PO_LABEL[po.status] ?? po.status}
          </span>
          <span className="mut" style={{ fontSize: 13 }}>{po.vendor}</span>
          <span className="mut" style={{ fontSize: 12 }}>→ {po.roomName}</span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
            {editable && (
              <>
                <button className="btn sm" onClick={() => setEditing(!editing)}>{editing ? "Cancel" : "Edit"}</button>
                <button className="btn sm accent" disabled={pending || !lines.length}
                  onClick={() => {
                    if (!confirm(`Send ${po.number} to ${po.vendor}? Lines lock after this.`)) return;
                    run(() => sendPurchaseOrder(po.id));
                  }}>Send to vendor</button>
              </>
            )}
          </span>
        </div>

        <div className="mut" style={{ fontSize: 12, marginBottom: 8 }}>
          Raised {po.when}
          {po.sentWhen ? ` · sent ${po.sentWhen}` : ""}
          {po.expectedAt ? ` · expected ${po.expectedAt}` : ""}
          {po.reference ? ` · ref ${po.reference}` : ""}
        </div>
        {po.note && <div style={{ fontSize: 12, marginBottom: 8 }}>{po.note}</div>}
        {po.status === "cancelled" && po.cancelReason && (
          <div style={{ fontSize: 12, color: "#8A5410", background: "#FAF0DC", border: "1px solid #F0C9A0", borderRadius: 8, padding: "8px 12px", marginBottom: 8 }}>
            Cancelled: {po.cancelReason}. Anything already received stayed on the shelf.
          </div>
        )}

        {editing && (
          <div className="dash-form" style={{ marginBottom: 10 }}>
            <div className="pf2" style={{ marginBottom: 8 }}>
              <div><label>Vendor *</label><input value={head.vendor} list="maker-book" onChange={(e) => setHead({ ...head, vendor: e.target.value })} />
                <datalist id="maker-book">{(makers ?? []).map((m) => <option key={m} value={m} />)}</datalist></div>
              <div><label>Reference</label><input value={head.reference} onChange={(e) => setHead({ ...head, reference: e.target.value })} placeholder="Vendor quote #" /></div>
              <div><label>Expected</label><input value={head.expectedAt} onChange={(e) => setHead({ ...head, expectedAt: e.target.value })} placeholder="Jul 23" /></div>
            </div>
            <div style={{ marginBottom: 8 }}>
              <label>Note</label>
              <input value={head.note} onChange={(e) => setHead({ ...head, note: e.target.value })} />
            </div>
            <button className="btn sm accent" disabled={pending || !head.vendor.trim()}
              onClick={() => run(() => updatePurchaseOrder(po.id, head), () => setEditing(false))}>
              {pending ? "Saving..." : "Save"}
            </button>
          </div>
        )}

        {lines.map((l) => {
          const out = lineOutstanding(l);
          const total = lineTotalCents(l);
          const isReceiving = receiving?.id === l.id;
          return (
            <div key={l.id} style={{ borderTop: "1px solid var(--line)", padding: "7px 0" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                <span className="mono" style={{ fontSize: 13, fontWeight: 700 }}>{l.partNumber}</span>
                {l.name && <span style={{ fontSize: 13 }}>{l.name}</span>}
                <span className="mut" style={{ fontSize: 12 }}>× {l.qtyOrdered}</span>
                {l.unitCents !== null
                  ? <span className="mut" style={{ fontSize: 12 }}>{formatCents(l.unitCents)} ea · {formatCents(total!)}</span>
                  : <span style={{ fontSize: 12, color: "#8A5410" }}>unpriced</span>}
                {l.qtyReceived > 0 && (
                  <span className="pill" style={{
                    background: out === 0 ? "#E8F3EC" : "#FAF0DC", color: out === 0 ? "#2E6B2E" : "#8A5410", fontWeight: 700,
                  }}>{l.qtyReceived} received{out > 0 ? `, ${out} to come` : ""}</span>
                )}
                <span style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
                  {receivable && out > 0 && (
                    <button className="btn link" style={{ fontSize: 12, fontWeight: 700 }}
                      onClick={() => { setError(""); setReceiving(isReceiving ? null : { id: l.id, qty: String(out), note: "" }); }}>
                      receive
                    </button>
                  )}
                  {editable && (
                    <button className="btn link" style={{ color: "#A32D2D", fontSize: 12 }} disabled={pending}
                      onClick={() => run(() => deletePoLine(l.id))}>remove</button>
                  )}
                </span>
              </div>
              {l.note && <div className="mut" style={{ fontSize: 12 }}>{l.note}</div>}

              {editable && (
                <div style={{ display: "flex", gap: 6, marginTop: 4, flexWrap: "wrap", alignItems: "center" }}>
                  <span className="mut" style={{ fontSize: 11 }}>qty</span>
                  <input defaultValue={String(l.qtyOrdered)} inputMode="numeric" aria-label={`Quantity for ${l.partNumber}`}
                    onBlur={(e) => {
                      if (e.target.value.trim() === String(l.qtyOrdered)) return;
                      run(() => setPoLine(l.id, { qty: e.target.value, price: l.unitCents === null ? "" : centsToInput(l.unitCents) }));
                    }}
                    style={{ width: 60, fontSize: 12 }} />
                  <span className="mut" style={{ fontSize: 11 }}>unit $</span>
                  <input defaultValue={l.unitCents === null ? "" : centsToInput(l.unitCents)} aria-label={`Unit price for ${l.partNumber}`}
                    placeholder="129.95"
                    onBlur={(e) => {
                      const was = l.unitCents === null ? "" : centsToInput(l.unitCents);
                      if (e.target.value.trim() === was) return;
                      run(() => setPoLine(l.id, { qty: String(l.qtyOrdered), price: e.target.value }));
                    }}
                    style={{ width: 90, fontSize: 12 }} />
                </div>
              )}

              {isReceiving && (
                <div className="dash-form" style={{ marginTop: 6, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <span className="mut" style={{ fontSize: 11 }}>arrived</span>
                  <input value={receiving.qty} onChange={(e) => setReceiving({ ...receiving, qty: e.target.value })}
                    inputMode="numeric" aria-label="How many arrived" style={{ width: 64, minHeight: 34, textAlign: "center" }} />
                  <span className="mut" style={{ fontSize: 12 }}>of {out}</span>
                  <input value={receiving.note} onChange={(e) => setReceiving({ ...receiving, note: e.target.value })}
                    placeholder="Packing slip / note" style={{ flex: "1 1 160px", minHeight: 34, fontSize: 13 }} />
                  <button className="btn sm accent" style={{ minHeight: 34 }} disabled={pending}
                    onClick={() => {
                      const n = parseInt(receiving.qty, 10);
                      if (!Number.isInteger(n) || n <= 0) { setError("How many arrived? Whole numbers above zero."); return; }
                      run(() => receivePoLine(l.id, n, receiving.note), () => setReceiving(null));
                    }}>{pending ? "Booking..." : "Book in"}</button>
                  <button className="btn sm" style={{ minHeight: 34 }} onClick={() => setReceiving(null)}>Cancel</button>
                </div>
              )}
            </div>
          );
        })}

        {lines.length === 0 && <div className="mut" style={{ fontSize: 13 }}>Nothing on this order yet.</div>}

        {editable && (adding ? (
          <div className="dash-form" style={{ marginTop: 10 }}>
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
              <div><label>Qty</label><input value={newLine.qty} inputMode="numeric" onChange={(e) => setNewLine({ ...newLine, qty: e.target.value })} /></div>
              <div><label>Unit $</label><input value={newLine.price} onChange={(e) => setNewLine({ ...newLine, price: e.target.value })} placeholder="129.95" /></div>
            </div>
            <button className="btn sm accent" disabled={pending || !newLine.partNumber.trim()}
              onClick={() => run(() => addPoLine(po.id, newLine), () => { setAdding(false); setNewLine({ partNumber: "", name: "", qty: "1", price: "" }); })}>
              {pending ? "Adding..." : "Add line"}
            </button>
          </div>
        ) : (
          <button className="btn link" style={{ fontSize: 12, marginTop: 8 }} onClick={() => setAdding(true)}>+ add a line</button>
        ))}

        {lines.length > 0 && (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, fontSize: 12, marginTop: 10, borderTop: "1px solid var(--line)", paddingTop: 8 }}>
            <span className="mut">
              {totals.received} of {totals.ordered} received
              {totals.unpriced ? ` · ${totals.unpriced} line${totals.unpriced === 1 ? "" : "s"} unpriced` : ""}
            </span>
            <b>{formatCents(totals.cents)}</b>
          </div>
        )}

        {canManage && po.status !== "cancelled" && po.status !== "received" && (
          <button className="btn link" style={{ color: "#A32D2D", fontSize: 12, marginTop: 10, fontWeight: 700 }} disabled={pending}
            onClick={() => {
              const why = promptReason(`Cancel ${po.number}? Anything already received stays on the shelf.`);
              if (!why) return;
              run(() => cancelPurchaseOrder(po.id, why));
            }}>Cancel this order</button>
        )}
        {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{error}</div>}
      </div>
    </>
  );
}
