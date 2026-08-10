"use client";

import { useState, useTransition } from "react";
import { handOffSystem } from "@/app/actions";

export type CustodyRow = {
  id: number; kind: string; fromName: string; toName: string; note: string; when: string; actor: string;
};

const KIND_WORD: Record<string, string> = {
  intake: "First owner on record",
  transfer: "Handed on",
  claim: "Claimed and granted",
  release: "Returned to house stewardship",
};

/**
 * Chain of custody, and the handoff that extends it. For a system that will be
 * resold, provenance is the asset: a serial number that can show who has held
 * it and when is worth more than one that can't.
 */
export default function CustodyPanel({ instrumentId, externalId, events, ownerName, providers, orgOptions, canHandOff }: {
  instrumentId: number;
  externalId: string;
  events: CustodyRow[];
  ownerName: string;
  /** Everyone else with access right now - they survive a handoff by design. */
  providers: { name: string; kind: string; access: string }[];
  orgOptions: { id: number; name: string; kind: string }[];
  canHandOff: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [toOrgId, setToOrgId] = useState(0);
  const [note, setNote] = useState("");
  const [keep, setKeep] = useState(false);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const target = orgOptions.find((o) => o.id === toOrgId);

  if (!canHandOff && events.length === 0) return null;

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <div className="card-title">Ownership history</div>
        {canHandOff && (
          <button className="btn sm primary" style={{ marginLeft: "auto" }} onClick={() => { setOpen(!open); setError(""); }}>
            {open ? "Cancel" : "Hand off"}
          </button>
        )}
      </div>
      <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
        Currently owned by <b style={{ color: "var(--ink)" }}>{ownerName}</b>.
        The service history stays with the system through every change of hands.
      </div>

      {open && (
        <div className="dash-form" style={{ marginBottom: 12 }}>
          <div style={{ marginBottom: 8 }}>
            <label>Hand {externalId} to</label>
            <select value={toOrgId} onChange={(e) => setToOrgId(parseInt(e.target.value))}>
              <option value={0}>Pick the new owner…</option>
              {orgOptions.map((o) => <option key={o.id} value={o.id}>{o.name} ({o.kind})</option>)}
            </select>
          </div>
          <div style={{ marginBottom: 8 }}>
            <label>Note for the record</label>
            <input value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Shipped to end customer, PO 4471" />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginBottom: 10 }}>
            <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} style={{ width: 15, height: 15 }} />
            Keep {ownerName} on as a viewer — usual when they resold it and still want visibility.
          </label>

          <div style={{ fontSize: 12, background: "#F4F7FB", border: "1px solid var(--line)", borderRadius: 8, padding: "8px 12px", marginBottom: 10 }}>
            <b>What happens:</b>
            <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
              <li>{target?.name ?? "The new owner"} gets ownership and full edit access.</li>
              <li>{ownerName} keeps a frozen record of their period of ownership
                {keep ? " and read-only access." : " and loses live access."}</li>
              <li>
                {providers.length
                  ? <>Access is unchanged for {providers.map((p) => p.name).join(", ")} — they keep working the system.</>
                  : <>Nobody else currently has access.</>}
              </li>
              <li>Part costs and PO numbers recorded by {ownerName} stay hidden from the new owner.</li>
            </ul>
          </div>

          <button className="btn sm accent" disabled={pending || !toOrgId}
            onClick={() => {
              if (!confirm(`Hand ${externalId} to ${target?.name}? This is recorded permanently.`)) return;
              setError("");
              startTransition(async () => {
                const res = await handOffSystem(instrumentId, toOrgId, { note, keepPreviousAsViewer: keep });
                if (res?.error) setError(res.error);
                else { setOpen(false); setToOrgId(0); setNote(""); setKeep(false); }
              });
            }}>{pending ? "Handing off..." : "Record the handoff"}</button>
          {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{error}</div>}
        </div>
      )}

      {events.length === 0 && (
        <div className="mut" style={{ fontSize: 13 }}>No ownership changes recorded.</div>
      )}
      {events.map((e) => (
        <div key={e.id} style={{ borderTop: "1px solid var(--line)", padding: "6px 0", fontSize: 13 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 700 }}>
              {e.fromName && e.toName ? `${e.fromName} → ${e.toName}` : e.toName || e.fromName || "unknown"}
            </span>
            <span className="mut" style={{ fontSize: 11 }}>{KIND_WORD[e.kind] ?? e.kind}</span>
            <span className="mut" style={{ fontSize: 11, marginLeft: "auto" }}>{e.when}</span>
          </div>
          {e.note && <div className="mut" style={{ fontSize: 12 }}>{e.note}</div>}
        </div>
      ))}
    </div>
  );
}
