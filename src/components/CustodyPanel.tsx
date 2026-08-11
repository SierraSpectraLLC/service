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
  // Second click on the handoff button, in place of a native confirm().
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const target = orgOptions.find((o) => o.id === toOrgId);

  if (!canHandOff && events.length === 0) return null;

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <div className="card-title">Ownership history</div>
        {canHandOff && (
          <button className="btn sm primary" style={{ marginLeft: "auto" }} onClick={() => { setOpen(!open); setError(""); setArmed(false); }}>
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
            <select value={toOrgId} onChange={(e) => { setToOrgId(parseInt(e.target.value)); setArmed(false); }}>
              <option value={0}>Pick the new owner…</option>
              {orgOptions.map((o) => <option key={o.id} value={o.id}>{o.name} ({o.kind})</option>)}
            </select>
          </div>
          <div style={{ marginBottom: 8 }}>
            <label>Note for the record</label>
            <input value={note} onChange={(e) => { setNote(e.target.value); setArmed(false); }}
              placeholder="Shipped to end customer, PO 4471" />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, marginBottom: 10 }}>
            <input type="checkbox" checked={keep} onChange={(e) => { setKeep(e.target.checked); setArmed(false); }} style={{ width: 15, height: 15 }} />
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

          {/* Two clicks, no window.confirm(). Browsers offer to suppress repeat
              dialogs from a page, and once that's ticked every confirm()
              returns false - so a native dialog makes the button silently do
              nothing. The consequence list above IS the confirmation; arming
              the button is the second deliberate act. */}
          {!toOrgId ? (
            <div className="mut" style={{ fontSize: 12 }}>Pick the new owner above to continue.</div>
          ) : (
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button className={`btn sm ${armed ? "accent" : "primary"}`} disabled={pending}
                onClick={() => {
                  if (!armed) { setArmed(true); setError(""); return; }
                  setError("");
                  startTransition(async () => {
                    try {
                      const res = await handOffSystem(instrumentId, toOrgId, { note, keepPreviousAsViewer: keep });
                      if (res?.error) { setError(res.error); setArmed(false); return; }
                      setOpen(false); setArmed(false); setToOrgId(0); setNote(""); setKeep(false);
                    } catch (e) {
                      // A server action that throws used to reject into nothing,
                      // which is indistinguishable from a dead button.
                      setArmed(false);
                      setError(`The handoff didn't go through: ${(e as Error).message || "server error"}`);
                    }
                  });
                }}>
                {pending ? "Handing off..." : armed ? `Yes - hand it to ${target?.name}` : `Hand off to ${target?.name}`}
              </button>
              {armed && !pending && (
                <>
                  <span className="mut" style={{ fontSize: 11 }}>Permanent, and recorded.</span>
                  <button className="btn sm" onClick={() => setArmed(false)}>Back</button>
                </>
              )}
            </div>
          )}
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
