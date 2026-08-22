"use client";

import Link from "next/link";
import { toast } from "@/components/ui/Toast";
import { useMemo, useState, useTransition } from "react";
import { orderNeededParts, sendPartsRequest } from "@/app/actions";
import { fmtWhen } from "@/lib/when";

export type NeededPart = {
  id: number;
  name: string;
  partNumber: string;
  qty: string;
  vendor: string;
  /** The system it is needed on, when it is on one. */
  instrumentId: number | null;
  assetId: number | null;
  externalId: string | null;
  /** Which organization owns the system - who would be asked to order. */
  ownerOrgId: number | null;
  ownerName: string;
  /** Set once somebody has been asked to buy it. */
  requestedOrgName: string;
  requestedAt: string | null;
};

/**
 * What the floor says it needs, on the page where things get bought.
 *
 * Purchasing listened only to the shelf: a stock item below its minimum. A part
 * marked Needed on an instrument - the one with a system waiting on it - lived
 * on that instrument's page and had to be retyped into an order by hand. This
 * is the missing half of the queue, with the two honest ways out of it: order
 * it ourselves, or hand the list to the client who buys their own.
 */
export default function NeededPartsCard({ parts, rooms, canOrder }: {
  parts: NeededPart[];
  /** Stockrooms this person may order into. */
  rooms: { id: number; name: string }[];
  canOrder: boolean;
}) {
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [roomId, setRoomId] = useState<string>(rooms[0] ? String(rooms[0].id) : "");
  const [note, setNote] = useState("");
  const [asking, setAsking] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error: boolean } | null>(null);
  const [pending, startTransition] = useTransition();

  const chosen = useMemo(() => parts.filter((p) => picked.has(p.id)), [parts, picked]);
  // One order goes to one vendor and one client is asked at a time; both
  // buttons say which, so a mixed selection explains itself rather than
  // silently doing something surprising.
  const vendors = [...new Set(chosen.map((p) => p.vendor.trim()).filter(Boolean))];
  const askOrgs = [...new Set(chosen.map((p) => p.ownerOrgId).filter((x): x is number => x !== null))];
  const askOrgName = chosen.find((p) => p.ownerOrgId === askOrgs[0])?.ownerName ?? "";

  const toggle = (id: number) =>
    setPicked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  // Success is a toast; an error stays on the card next to what failed.
  const done = (text: string, error = false) => {
    if (!error) { toast({ message: text }); return; }
    setMsg({ text, error });
    setTimeout(() => setMsg(null), 6000);
  };

  if (!parts.length) return null;

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
        <div className="card-title">Needed on systems</div>
        <span className="pill warn">{parts.length}</span>
        {picked.size > 0 && <span className="mut t-meta">{picked.size} selected</span>}
      </div>
      <div className="mut t-small" style={{ marginBottom: 8 }}>
        Parts marked <b>Needed</b> on an instrument or unit - a system is waiting on each of these.
        Order them here, or hand the list to a client who buys their own.
      </div>

      {parts.map((p) => (
        <label key={p.id} className="row-hover"
          style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "6px 4px", borderTop: "1px solid var(--line)", cursor: "pointer", margin: 0 }}>
          <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)}
            style={{ width: 15, height: 15, flexShrink: 0 }} aria-label={`Select ${p.name}`} />
          <span className="t-body" style={{ flex: "1 1 150px", minWidth: 0 }}>{p.name}</span>
          {p.partNumber && <span className="mono mut t-meta">{p.partNumber}</span>}
          {p.qty && p.qty !== "1" && <span className="mut t-meta">x{p.qty}</span>}
          {p.vendor && <span className="pill neutral">{p.vendor}</span>}
          {p.externalId && p.instrumentId !== null && (
            <Link href={`/instruments/${p.instrumentId}`} onClick={(e) => e.stopPropagation()}
              className="pill info" style={{ textDecoration: "none" }}>
              {p.externalId}
            </Link>
          )}
          {/* Whose move it is. Without this, a part somebody already asked the
              client to buy looks exactly like one nobody has touched. */}
          {p.requestedAt && (
            <span className="pill good"
              title={`Asked ${p.requestedOrgName} on ${fmtWhen(p.requestedAt)}`}>
              asked {p.requestedOrgName}
            </span>
          )}
        </label>
      ))}

      {canOrder && picked.size > 0 && (
        <div style={{ marginTop: 10, padding: "8px 10px", border: "1px solid var(--line)", borderRadius: 8, background: "#FAFBFD" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <select value={roomId} onChange={(e) => setRoomId(e.target.value)}
              className="t-small" style={{ width: "auto" }} aria-label="Deliver to stockroom">
              {rooms.map((r) => <option key={r.id} value={String(r.id)}>{r.name}</option>)}
            </select>
            <button className="btn sm accent" disabled={pending || !roomId || vendors.length !== 1}
              title={vendors.length === 1
                ? `Draft a ${vendors[0]} order for ${picked.size} part${picked.size === 1 ? "" : "s"}`
                : "One order goes to one vendor - narrow the selection, or set the vendor on these parts"}
              onClick={() => startTransition(async () => {
                const res = await orderNeededParts([...picked], { vendor: vendors[0], stockroomId: parseInt(roomId) });
                if (res?.error) { done(res.error, true); return; }
                setPicked(new Set());
                // The allowance heads-up rides along; the order stands either way.
                done(`Drafted ${res.number} - open it in Purchasing to send it${res.flag ? `. ${res.flag}` : ""}`);
              })}>
              {pending ? "Drafting..." : vendors.length === 1 ? `Draft a ${vendors[0]} order` : "Draft an order"}
            </button>
            {askOrgs.length === 1 && (
              <button className="btn sm" disabled={pending} onClick={() => setAsking((v) => !v)}>
                {asking ? "Cancel" : `Ask ${askOrgName} to order`}
              </button>
            )}
          </div>
          {vendors.length > 1 && (
            <div className="mut t-meta" style={{ marginTop: 6 }}>
              Selected parts come from {vendors.length} vendors ({vendors.join(", ")}) - one order goes to one vendor.
            </div>
          )}
          {vendors.length === 0 && (
            <div className="mut t-meta" style={{ marginTop: 6 }}>
              None of these name a vendor. Set one on the part, or in the parts book.
            </div>
          )}
          {askOrgs.length > 1 && (
            <div className="mut t-meta" style={{ marginTop: 6 }}>
              Selected parts belong to different organizations - ask one at a time.
            </div>
          )}

          {/* Handing the list over: the parts stay Needed, because they are. */}
          {asking && askOrgs.length === 1 && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}>
              <input value={note} onChange={(e) => setNote(e.target.value)}
                placeholder="Anything to add - urgency, which visit it's for (optional)"
                className="t-small" style={{ width: "auto", flex: "2 1 200px" }} />
              <button className="btn sm accent" disabled={pending}
                onClick={() => startTransition(async () => {
                  const res = await sendPartsRequest(askOrgs[0], [...picked], note);
                  if (res?.error) { done(res.error, true); return; }
                  setPicked(new Set()); setAsking(false); setNote("");
                  done(`Sent ${res.sent} part${res.sent === 1 ? "" : "s"} to ${askOrgName}`);
                })}>
                {pending ? "Sending..." : `Send to ${askOrgName}`}
              </button>
              <span className="mut t-meta" style={{ flexBasis: "100%" }}>
                They stay <b>Needed</b> here - nothing has been ordered - but the record will say
                who was asked and when.
              </span>
            </div>
          )}
        </div>
      )}

      {msg && (
        <div className="t-small" style={{ marginTop: 8, fontWeight: 700, color: msg.error ? "#A32D2D" : "#2E6B2E" }}>
          {msg.text}
        </div>
      )}
    </div>
  );
}
