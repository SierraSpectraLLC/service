"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { recordHistoricalPurchaseOrder } from "@/app/actions";
import { PO_OUTCOMES, poProblem, usablePoLines } from "@/lib/backfill";
import { formatCents } from "@/lib/money";

type Row = { partNumber: string; name: string; qty: string; price: string };
const blankRow = (): Row => ({ partNumber: "", name: "", qty: "1", price: "" });

const cents = (s: string) => {
  const n = parseFloat(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const qtyOf = (s: string) => {
  const n = parseInt(s.replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const OUTCOMES: Record<(typeof PO_OUTCOMES)[number], string> = {
  received: "Received",
  sent: "Still outstanding",
  cancelled: "Cancelled",
};

/**
 * A purchase order that was already placed.
 *
 * The sibling of the invoice and quote history doors, and the one a migrating
 * shop needs most: a part sitting on a shelf with no order behind it cannot be
 * traced to what was paid for it. Same posture as the others - nothing is
 * emailed to the vendor, no receiving notification fires, and no stock moves.
 * A received order writes its lines already received because that is what
 * happened, not because pressing a button here should shelve anything today.
 */
export default function BackfillPoButton({ rooms }: {
  rooms: { id: number; name: string }[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [form, setForm] = useState({
    number: "", vendor: "", orderedOn: "", reference: "", note: "",
    outcome: "received" as string, stockroomId: "",
  });
  const [rows, setRows] = useState<Row[]>([blankRow()]);
  const [error, setError] = useState("");

  const lines = rows.map((r) => ({
    partNumber: r.partNumber, name: r.name, qty: qtyOf(r.qty), unitCents: cents(r.price),
  }));
  const problem = poProblem({
    vendor: form.vendor, orderedOn: form.orderedOn, outcome: form.outcome, lines,
  });
  const total = usablePoLines(lines).reduce((n, l) => n + l.qty * l.unitCents, 0);

  const setRow = (i: number, patch: Partial<Row>) =>
    setRows(rows.map((r, n) => (n === i ? { ...r, ...patch } : r)));

  const save = () =>
    startTransition(async () => {
      const res = await recordHistoricalPurchaseOrder({
        number: form.number, vendor: form.vendor, orderedOn: form.orderedOn,
        reference: form.reference, note: form.note, outcome: form.outcome,
        stockroomId: form.stockroomId ? parseInt(form.stockroomId, 10) : null,
        lines,
      });
      if (res?.error) { setError(res.error); return; }
      toast({ message: `Recorded ${res.number} as history - nothing was sent` });
      setOpen(false);
      setForm({ number: "", vendor: "", orderedOn: "", reference: "", note: "", outcome: "received", stockroomId: "" });
      setRows([blankRow()]);
      router.refresh();
    });

  return (
    <>
      <button className="btn sm" onClick={() => { setError(""); setOpen(true); }}>
        Record history
      </button>

      {open && (
        <Dialog open onClose={() => setOpen(false)} size="md"
          title="Record a past purchase order"
          context="Paper that was already placed. Nothing here reaches the vendor and no stock moves."
          footer={
            <>
              <DialogStatus error={error} problem={problem} />
              <button className="btn" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={save} disabled={pending || !!problem}>
                {pending ? "Recording..." : `Record${total ? ` ${formatCents(total)}` : ""}`}
              </button>
            </>
          }>
          <div className="pf2">
            <div>
              <label>Vendor</label>
              <input value={form.vendor} aria-label="Vendor" autoFocus
                onChange={(e) => setForm({ ...form, vendor: e.target.value })} />
            </div>
            <div>
              <label>Ordered on</label>
              <input type="date" value={form.orderedOn} aria-label="Ordered on"
                onChange={(e) => setForm({ ...form, orderedOn: e.target.value })} />
            </div>
          </div>

          <div className="pf2">
            <div>
              <label>Their number</label>
              <input className="mono t-small" value={form.number} aria-label="Purchase order number"
                placeholder="blank uses ours"
                onChange={(e) => setForm({ ...form, number: e.target.value })} />
              {/* The vendor has a copy filed under their number. A migration
                  that renumbers makes every future call about an old order
                  harder than it needs to be. */}
              <div className="field-hint">Whatever it was called. Leave it blank for the next in our series.</div>
            </div>
            <div>
              <label>How it ended</label>
              <select value={form.outcome} aria-label="Outcome"
                onChange={(e) => setForm({ ...form, outcome: e.target.value })}>
                {PO_OUTCOMES.map((o) => <option key={o} value={o}>{OUTCOMES[o]}</option>)}
              </select>
            </div>
          </div>

          <div className="pf2">
            <div>
              <label>Into which stockroom</label>
              <select value={form.stockroomId} aria-label="Stockroom"
                onChange={(e) => setForm({ ...form, stockroomId: e.target.value })}>
                <option value="">not recorded</option>
                {rooms.map((r) => <option key={r.id} value={String(r.id)}>{r.name}</option>)}
              </select>
            </div>
            <div>
              <label>Vendor reference</label>
              <input value={form.reference} aria-label="Vendor reference"
                onChange={(e) => setForm({ ...form, reference: e.target.value })} />
            </div>
          </div>

          <div className="dialog-section">What was on it</div>
          {rows.map((r, i) => (
            <div key={i} style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
              <input className="mono t-small" style={{ flex: "1 1 110px", minWidth: 90 }}
                placeholder="part number" value={r.partNumber} aria-label={`Part number ${i + 1}`}
                onChange={(e) => setRow(i, { partNumber: e.target.value })} />
              <input style={{ flex: "2 1 140px", minWidth: 110 }}
                placeholder="description" value={r.name} aria-label={`Description ${i + 1}`}
                onChange={(e) => setRow(i, { name: e.target.value })} />
              <input style={{ width: 60 }} inputMode="numeric" placeholder="qty" value={r.qty}
                aria-label={`Quantity ${i + 1}`}
                onChange={(e) => setRow(i, { qty: e.target.value })} />
              <input style={{ width: 90 }} inputMode="decimal" placeholder="each" value={r.price}
                aria-label={`Unit price ${i + 1}`}
                onChange={(e) => setRow(i, { price: e.target.value })} />
              {rows.length > 1 && (
                <button className="btn link" style={{ fontSize: 12 }}
                  onClick={() => setRows(rows.filter((_, n) => n !== i))}>remove</button>
              )}
            </div>
          ))}
          <button className="btn sm" onClick={() => setRows([...rows, blankRow()])}
            disabled={rows.length >= 40}>
            + Line
          </button>

          <label style={{ marginTop: 10 }}>Note</label>
          <input value={form.note} aria-label="Note"
            onChange={(e) => setForm({ ...form, note: e.target.value })} />
          <div className="field-hint">
            {form.outcome === "received"
              ? "Its lines are written already received. The shelf is whatever the shelf says - this is the paper behind it, and nothing moves stock."
              : "Nothing is emailed to the vendor and no receiving notification fires."}
          </div>
        </Dialog>
      )}
    </>
  );
}
