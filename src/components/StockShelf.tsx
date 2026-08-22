"use client";

import { useMemo, useState, useTransition } from "react";
import { promptReason } from "@/lib/reason";
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
      else close();
    });
  };

  if (!items.length) {
    return <div className="mut" style={{ fontSize: 13 }}>Nothing on this shelf yet.</div>;
  }

  return (
    <>
      {items.length > 8 && (
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by PN, description or bin"
          style={{ fontSize: 13, marginBottom: 10, maxWidth: 280 }} />
      )}

      {shown.map((i) => {
        const short = needsReorder(i);
        const isOpen = open?.id === i.id;
        return (
          <div key={i.id} style={{ borderTop: "1px solid var(--line)", padding: "8px 0" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <span className="mono" style={{ fontSize: 13, fontWeight: 700 }}>{i.partNumber}</span>
              {i.name && <span style={{ fontSize: 13 }}>{i.name}</span>}
              {i.bin && <span className="pill neutral">bin {i.bin}</span>}
              <span className={`pill ${short ? "bad" : "good"}`}>
                {i.qty} on hand
              </span>
              {short && (
                <span className="mut" style={{ fontSize: 11 }}>
                  reorder at {i.minQty} · short {shortBy(i)}
                </span>
              )}
              {showCosts && i.unitCostCents !== null && (
                <span className="mut" style={{ fontSize: 11 }}>{formatCents(i.unitCostCents)} ea</span>
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
                    onClick={() => {
                      const counted = prompt(`Counted how many ${i.partNumber} on the shelf?`, String(i.qty));
                      if (counted === null) return;
                      const n = parseInt(counted, 10);
                      if (!Number.isInteger(n) || n < 0) { setError("Count must be a whole number, zero or more"); return; }
                      if (n === i.qty) return;
                      const why = promptReason(`Post a correction of ${n - i.qty > 0 ? "+" : ""}${n - i.qty}? The ledger keeps both numbers.`);
                      if (!why) return;
                      startTransition(async () => {
                        const res = await recountStock(i.id, n, why);
                        if (res?.error) setError(res.error);
                      });
                    }}>recount</button>
                )}
              </span>
            </div>
            {i.note && <div className="mut" style={{ fontSize: 12, marginTop: 2 }}>{i.note}</div>}

            {isOpen && (
              <div className="dash-form" style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
                <div className="panel-head" style={{ marginBottom: 0 }}>
                  <span className="card-title" style={{ fontSize: 14 }}>
                    {open.mode === "issue" ? "Issue" : open.mode === "receive" ? "Receive" : "Move"}
                  </span>
                </div>
                <div className="row-2">
                  <button className="btn sm" style={TAP} onClick={() => setQty(String(Math.max(1, (parseInt(qty, 10) || 1) - 1)))} aria-label="One fewer">−</button>
                  <input value={qty} onChange={(e) => setQty(e.target.value)} inputMode="numeric" aria-label="How many"
                    style={{ width: 64, textAlign: "center", ...TAP }} />
                  <button className="btn sm" style={TAP} onClick={() => setQty(String((parseInt(qty, 10) || 0) + 1))} aria-label="One more">＋</button>
                  {open.mode !== "receive" && <span className="mut" style={{ fontSize: 12 }}>of {i.qty}</span>}
                </div>

                {open.mode === "issue" && (
                  <>
                    <select value={targetKey} onChange={(e) => setTargetKey(e.target.value)} aria-label="Where it's going" style={TAP}>
                      {targets.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
                    </select>
                    <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
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

                <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (optional)" style={TAP} />
                <div style={{ display: "flex", gap: 8 }}>
                  <button className="btn sm accent" style={TAP} onClick={() => run(i)} disabled={pending}>
                    {pending ? "Working..." : open.mode === "issue" ? "Issue" : open.mode === "receive" ? "Receive" : "Move"}
                  </button>
                  <button className="btn sm" style={TAP} onClick={close}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{error}</div>}
    </>
  );
}
