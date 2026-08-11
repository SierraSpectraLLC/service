"use client";

import { useState, useTransition } from "react";
import { kickToQueue } from "@/app/actions";

export type QueueLegRow = {
  id: number; fromName: string; toName: string; reason: string; actor: string; when: string;
};

/**
 * Whose move it is. Parking a system with the client is how finished-but-not-
 * shipped work leaves the shop's board without being archived or faked - and
 * how a blockage on their side stops counting against our turnaround.
 */
export default function QueuePanel({
  instrumentId, externalId, holderName, isMine, since, days, reason, legs, options, ourName, canKick,
}: {
  instrumentId: number;
  externalId: string;
  /** Who holds the queue right now, already resolved to a name. */
  holderName: string;
  /** True when the viewer is the one expected to act. */
  isMine: boolean;
  since: string;
  days: number;
  reason: string;
  legs: QueueLegRow[];
  /** Organizations with access to this system - the only valid destinations. */
  options: { id: number; name: string; kind: string }[];
  /** What to call our own queue. */
  ourName: string;
  canKick: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [toOrgId, setToOrgId] = useState<string>("");
  const [why, setWhy] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const parked = !isMine;
  const target = toOrgId === "" ? null : toOrgId === "us" ? null : parseInt(toOrgId);
  const targetName = toOrgId === "us" ? ourName : options.find((o) => String(o.id) === toOrgId)?.name ?? "";

  const send = () => {
    if (!toOrgId) { setError("Pick whose queue it goes into"); return; }
    if (why.trim().length < 3) { setError("Say what they're waiting on - it's the whole message"); return; }
    setError("");
    startTransition(async () => {
      const res = await kickToQueue(instrumentId, target, why);
      if (res?.error) setError(res.error);
      else { setOpen(false); setToOrgId(""); setWhy(""); }
    });
  };

  return (
    <div className="card" style={parked ? { borderLeft: "3px solid #8A5410" } : undefined}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
        <div className="card-title">Queue</div>
        {/* Only worth a chip when someone else is holding it - "ours" is the
            default state of every system on the board and says nothing. */}
        {!isMine && (
          <span className="pill" style={{
            background: parked ? "#FAF0DC" : "#E7EFF8", color: parked ? "#8A5410" : "#1D6396", fontWeight: 700,
          }}>
            With {holderName}
          </span>
        )}
        <span className="mut" style={{ fontSize: 12 }}>
          {days === 0 ? "since today" : `${days} day${days === 1 ? "" : "s"}`} · {since}
        </span>
        {canKick && (
          <button className="btn sm primary" style={{ marginLeft: "auto" }}
            onClick={() => { setOpen(!open); setError(""); }}>
            {open ? "Cancel" : "Move it"}
          </button>
        )}
      </div>

      {reason && (
        <div style={{ fontSize: 13, borderLeft: "3px solid var(--line)", padding: "4px 10px", margin: "6px 0" }}>
          {reason}
        </div>
      )}
      {!reason && (
        <div className="mut" style={{ fontSize: 12, marginBottom: 6 }}>
          {isMine
            ? "Nobody is waiting on anyone else. Move it to a client's queue when the next step is theirs."
            : `${holderName} has the next move on this system.`}
        </div>
      )}

      {open && (
        <div className="dash-form" style={{ marginTop: 8 }}>
          <div className="pf2" style={{ marginBottom: 8 }}>
            <div>
              <label>Into whose queue</label>
              <select value={toOrgId} onChange={(e) => setToOrgId(e.target.value)}>
                <option value="">Pick a queue…</option>
                {!isMine && <option value="us">{ourName} (take it back)</option>}
                {options.map((o) => <option key={o.id} value={String(o.id)}>{o.name} ({o.kind})</option>)}
              </select>
            </div>
            <div>
              <label>What are they waiting on? *</label>
              <input value={why} onChange={(e) => setWhy(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") send(); }}
                placeholder="Running application tests / your N2 generator tech" />
            </div>
          </div>
          <div className="mut" style={{ fontSize: 11, marginBottom: 10 }}>
            {targetName || "They"} get a notification with that reason, and {externalId} drops off
            our board until it comes back. Access, ownership and history are untouched, and the
            days it spends there don&apos;t count against our turnaround.
          </div>
          <button className="btn sm accent" onClick={send} disabled={pending}>
            {pending ? "Moving..." : `Move to ${targetName || "their"} queue`}
          </button>
          {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{error}</div>}
        </div>
      )}
      {!open && error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{error}</div>}

      {legs.length > 0 && (
        <>
          <div className="eyebrow" style={{ margin: "12px 0 4px" }}>Handovers</div>
          {legs.map((l) => (
            <div key={l.id} style={{ borderTop: "1px solid var(--line)", padding: "5px 0", fontSize: 12 }}>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "baseline" }}>
                <span style={{ fontWeight: 700 }}>{l.fromName} → {l.toName}</span>
                <span className="mut" style={{ marginLeft: "auto", fontSize: 11 }}>
                  {l.actor.split("@")[0]} · {l.when}
                </span>
              </div>
              {l.reason && <div className="mut">{l.reason}</div>}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
