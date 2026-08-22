"use client";

import { useMemo, useState, useTransition } from "react";
import { confirmReason, inputDialog } from "@/components/ui/ConfirmDialog";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { issueStock, receiveStock, recountStock, transferStock } from "@/app/actions";
import { needsReorder, shortBy } from "@/lib/stock";
import { formatCents } from "@/lib/money";
import { matchesQuery } from "@/lib/search";

export type ShelfItem = {
  id: number; partNumber: string; name: string; qty: number; minQty: number; bin: string;
  note: string; unitCostCents: number | null;
};

export type IssueTarget = { key: string; label: string; instrumentId: number | null; assetId: number | null };

/** Big enough to hit with a thumb - this panel gets used standing at a shelf. */
const TAP = { minHeight: 34, fontSize: 13 } as const;

export default function StockShelf({ items, targets, rooms, canIssue, canManage, showCosts }: {
  items: ShelfItem[];
  /** Systems and units this viewer may write to, for the issue picker. */
  targets: IssueTarget[];
  /** Other rooms this viewer can move stock into. */
  rooms: { id: number; name: string }[];
  canIssue: boolean;
  canManage: boolean;
  showCosts: boolean;
}) {
  const [open, setOpen] = useState<null | { id: number; mode: "issue" | "receive" | "move" }>(null);
  const [qty, setQty] = useState("1");
  const [targetKey, setTargetKey] = useState(targets[0]?.key ?? "");
  const [install, setInstall] = useState(false);
  const [toRoom, setToRoom] = useState(rooms[0]?.id ?? 0);
  const [note, setNote] = useState("");
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((i) =>
      matchesQuery(filter, [i.partNumber, i.name, i.bin]));
  }, [items, filter]);

  const start = (id: number, mode: "issue" | "receive" | "move") => {
    setError(""); setQty("1"); setNote(""); setInstall(false);
    setOpen(open?.id === id && open.mode === mode ? null : { id, mode });
  };
  const close = () => { setOpen(null); setError(""); };

  const run = (item: ShelfItem) => {
    const n = parseInt(qty, 10);
    if (!Number.isInteger(n) || n <= 0) { setError("How many? Whole numbers above zero."); return; }
    setError("");
    startTransition(async () => {
      let res: { error?: string } = {};
      if (open?.mode === "issue") {
        const t = targets.find((x) => x.key === targetKey);
        if (!t) { setError("Pick where it's going"); return; }
        res = await issueStock(item.id, n, { instrumentId: t.instrumentId, assetId: t.assetId }, { install, note });
      } else if (open?.mode === "receive") {
        res = await receiveStock(item.id, n, note);
      } else if (open?.mode === "move") {
        if (!toRoom) { setError("Pick a stockroom"); return; }
        res = await transferStock(item.id, toRoom, n, note);
      }
      if (res?.error) setError(res.error);
      else {
        const verb = open?.mode === "issue" ? "Issued" : open?.mode === "receive" ? "Received" : "Moved";
        toast({ message: `${verb} ${n} ${item.partNumber}` });
        close();
      }
    });
  };

  if (!items.length) {
    return <div className="mut t-body">Nothing on this shelf yet.</div>;
  }

  return (
    <>
      {items.length > 8 && (
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by PN, description or bin"
          className="t-body" style={{ marginBottom: 10, maxWidth: 280 }} />
      )}

      {shown.map((i) => {
        const short = needsReorder(i);
        const isOpen = open?.id === i.id;
        return (
          <div key={i.id} style={{ borderTop: "1px solid var(--line)", padding: "8px 0" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <span className="mono t-body" style={{ fontWeight: 700 }}>{i.partNumber}</span>
              {i.name && <span className="t-body">{i.name}</span>}
              {i.bin && <span className="pill neutral">bin {i.bin}</span>}
              <span className={`pill ${short ? "bad" : "good"}`}>
                {i.qty} on hand
              </span>
              {short && (
                <span className="mut t-meta">
                  reorder at {i.minQty} · short {shortBy(i)}
                </span>
              )}
              {showCosts && i.unitCostCents !== null && (
                <span className="mut t-meta">{formatCents(i.unitCostCents)} ea</span>
              )}
              <span style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
                {canIssue && targets.length > 0 && (
                  <button className="btn link" style={{ fontSize: 12, fontWeight: 700 }} onClick={() => start(i.id, "issue")}>
                    issue
                  </button>
                )}
                {canIssue && <button className="btn link" style={{ fontSize: 12 }} onClick={() => start(i.id, "receive")}>receive</button>}
                {canIssue && rooms.length > 0 && (
                  <button className="btn link" style={{ fontSize: 12 }} onClick={() => start(i.id, "move")}>move</button>
                )}
                {canManage && (
                  <button className="btn link" style={{ fontSize: 12 }} disabled={pending}
                    onClick={async () => {
                      const counted = await inputDialog({
                        title: `Recount ${i.partNumber}`, action: "Next",
                        label: "Counted how many on the shelf?", initial: String(i.qty),
                      });
                      if (counted === null) return;
                      const n = parseInt(counted, 10);
                      if (!Number.isInteger(n) || n < 0) { setError("Count must be a whole number, zero or more"); return; }
                      if (n === i.qty) return;
                      const why = await confirmReason({
                        title: `Post a correction of ${n - i.qty > 0 ? "+" : ""}${n - i.qty}?`,
                        body: "The ledger keeps both numbers.",
                        action: "Post correction", tone: "bad",
                      });
                      if (!why) return;
                      startTransition(async () => {
                        const res = await recountStock(i.id, n, why);
                        if (res?.error) setError(res.error);
                        else toast({ message: "Posted the correction" });
                      });
                    }}>recount</button>
                )}
              </span>
            </div>
            {i.note && <div className="mut t-small" style={{ marginTop: 2 }}>{i.note}</div>}

            {isOpen && (() => {
              const verb = open.mode === "issue" ? "Issue" : open.mode === "receive" ? "Receive" : "Move";
              const n = parseInt(qty, 10);
              const qtyOk = Number.isInteger(n) && n > 0;
              const problem = !qtyOk ? "how many? whole numbers above zero"
                : open.mode === "issue" && !targets.some((t) => t.key === targetKey) ? "pick where it's going"
                : open.mode === "move" && !toRoom ? "pick a stockroom"
                : null;
              return (
                <Dialog open onClose={close} size="sm"
                  title={`${verb} ${i.partNumber}`}
                  context={[i.name, `${i.qty} on hand`, i.bin ? `bin ${i.bin}` : ""].filter(Boolean).join(" · ")}
                  footer={
                    <>
                      <DialogStatus error={error} problem={problem} />
                      <button className="btn" onClick={close} disabled={pending}>Cancel</button>
                      <button className="btn accent" onClick={() => run(i)} disabled={pending || !!problem}>
                        {pending ? "Working..." : qtyOk ? `${verb} ${n}` : verb}
                      </button>
                    </>
                  }>
                  <div className="dialog-section">How many</div>
                  <div className="row-2">
                    <button className="btn sm" style={TAP} onClick={() => setQty(String(Math.max(1, (parseInt(qty, 10) || 1) - 1)))} aria-label="One fewer">−</button>
                    <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="numeric" aria-label="How many"
                      style={{ width: 64, textAlign: "center", ...TAP }} />
                    <button className="btn sm" style={TAP} onClick={() => setQty(String((parseInt(qty, 10) || 0) + 1))} aria-label="One more">＋</button>
                    {open.mode !== "receive" && <span className="mut t-small">of {i.qty}</span>}
                  </div>

                  {open.mode !== "receive" && <div className="dialog-section">Where it goes</div>}
                  {open.mode === "issue" && (
                    <>
                      <select value={targetKey} onChange={(e) => setTargetKey(e.target.value)} aria-label="Where it's going" style={TAP}>
                        {targets.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                      </select>
                      <label className="t-body" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8 }}>
                        <input type="checkbox" checked={install} onChange={(e) => setInstall(e.target.checked)} style={{ width: 16, height: 16 }} />
                        Installed now (otherwise it lands as Received)
                      </label>
                    </>
                  )}
                  {open.mode === "move" && (
                    <select value={toRoom} onChange={(e) => setToRoom(parseInt(e.target.value))} aria-label="Into which stockroom" style={TAP}>
                      {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                  )}

                  <div className="dialog-section">Note</div>
                  <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" style={TAP} aria-label="Note" />
                </Dialog>
              );
            })()}
          </div>
        );
      })}
      {error && !open && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}
    </>
  );
}
