"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  addRestorationCrate, assignComponentCrate, removeRestorationCrate,
  saveShipment, setRestorationBuyer,
} from "@/app/actions";
import AddressField from "@/components/AddressField";
import RestorationChecklistCard from "@/components/RestorationChecklistCard";
import { toast } from "@/components/ui/Toast";
import type { ShipStageData } from "@/lib/restorationData";

const FLAGS = [
  ["dock", "Loading dock"],
  ["groundFloor", "Ground floor"],
  ["liftgate", "Liftgate needed"],
  ["garageDoor", "Garage door"],
  ["secondFloor", "Second floor"],
] as const;

/** The Ship stage: buyer + destination, prep checklist, the crate manifest
 * (every box, every serial), and carrier & cover. */
export default function RestorationShip({ projectId, data, canEdit }: {
  projectId: number;
  data: ShipStageData;
  canEdit: boolean;
}) {
  const router = useRouter();
  const s = data.shipment;
  const [draft, setDraft] = useState({
    destName: s?.destName ?? "",
    formatted: s?.formatted ?? "",
    contactName: s?.contactName ?? "",
    contactPhone: s?.contactPhone ?? "",
    dock: s?.dock ?? false,
    groundFloor: s?.groundFloor ?? false,
    liftgate: s?.liftgate ?? false,
    garageDoor: s?.garageDoor ?? false,
    secondFloor: s?.secondFloor ?? false,
    declaredValue: s && s.declaredValueCents ? String(s.declaredValueCents / 100) : "",
    carrier: s?.carrier ?? "",
    trackingNumber: s?.trackingNumber ?? "",
    pickupOn: s?.pickupOn ?? "",
    pickupNote: s?.pickupNote ?? "",
  });
  const [crate, setCrate] = useState({ label: "", weight: "" });
  const [pending, startTransition] = useTransition();

  const act = (fn: () => Promise<{ error?: string } | void>, done?: string) =>
    startTransition(async () => {
      const res = await fn();
      if (res && "error" in res && res.error) { toast({ message: res.error, tone: "bad" }); return; }
      if (done) toast({ message: done });
      router.refresh();
    });

  const save = () => act(() => saveShipment(projectId, {
    destName: draft.destName, formatted: draft.formatted,
    contactName: draft.contactName, contactPhone: draft.contactPhone,
    dock: draft.dock, groundFloor: draft.groundFloor, liftgate: draft.liftgate,
    garageDoor: draft.garageDoor, secondFloor: draft.secondFloor,
    declaredValueCents: Math.round(parseFloat(draft.declaredValue || "0") * 100) || 0,
    carrier: draft.carrier, trackingNumber: draft.trackingNumber,
    pickupOn: draft.pickupOn, pickupNote: draft.pickupNote,
  }), "Shipment saved");

  return (
    <>
      <section className="card">
        <h2 className="card-title">Destination <span className="eyebrow">where the record goes next</span></h2>
        <div style={{ marginBottom: 8 }}>
          <label>Buyer</label>
          <select value={data.buyerChoices.find((b) => b.name === data.buyerName)?.id ?? ""}
            disabled={!canEdit}
            onChange={(e) => act(() => setRestorationBuyer(projectId, parseInt(e.target.value) || 0))}>
            <option value="">No buyer yet — the gate insists before shipping</option>
            {data.buyerChoices.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        <div className="pf2" style={{ marginBottom: 8 }}>
          <div>
            <label>Ship-to name</label>
            <input value={draft.destName} disabled={!canEdit} placeholder="Testen Laboratories"
              onChange={(e) => setDraft({ ...draft, destName: e.target.value })} />
          </div>
          <div>
            <label>On-site contact</label>
            <input value={draft.contactName} disabled={!canEdit} placeholder="Name"
              onChange={(e) => setDraft({ ...draft, contactName: e.target.value })} />
          </div>
        </div>
        <div style={{ marginBottom: 8 }}>
          <label>Address</label>
          {canEdit ? (
            <AddressField value={draft.formatted} ariaLabel="Destination address"
              placeholder="3148 MLK Blvd, Lynwood, CA 90262"
              onChange={(formatted) => setDraft((d) => ({ ...d, formatted }))} />
          ) : (
            <div className="t-body">{draft.formatted || "—"}</div>
          )}
        </div>
        <div className="pf2" style={{ marginBottom: 8 }}>
          <div>
            <label>Contact phone</label>
            <input value={draft.contactPhone} disabled={!canEdit}
              onChange={(e) => setDraft({ ...draft, contactPhone: e.target.value })} />
          </div>
          <div />
        </div>
        <label>Facility</label>
        <div className="row sp-2" style={{ flexWrap: "wrap" }}>
          {FLAGS.map(([key, label]) => (
            <label key={key} className="t-body row al-center sp-1" style={{ cursor: canEdit ? "pointer" : "default", fontWeight: 400, color: "var(--ink)" }}>
              <input type="checkbox" checked={draft[key]} disabled={!canEdit}
                onChange={(e) => setDraft({ ...draft, [key]: e.target.checked })} />
              {label}
            </label>
          ))}
        </div>
      </section>

      <RestorationChecklistCard projectId={projectId} stage="ship_prep"
        title="Prep checklist" eyebrow="per instrument type — frozen from the template"
        data={data.prep} canEdit={canEdit} />

      <section className="card">
        <h2 className="card-title">Manifest &amp; crates <span className="eyebrow">every box, every serial</span></h2>
        {data.crateList.length > 0 && (
          <div className="row sp-2" style={{ flexWrap: "wrap", marginBottom: 8 }}>
            {data.crateList.map((c) => (
              <span key={c.id} className="pill neutral">
                {c.label}{c.weightLb ? ` · ${c.weightLb} lb` : ""}
                {canEdit && (
                  <button className="btn link" style={{ marginLeft: 4 }} disabled={pending}
                    onClick={() => act(() => removeRestorationCrate(c.id))}>✕</button>
                )}
              </span>
            ))}
          </div>
        )}
        {canEdit && (
          <div className="row al-center sp-2" style={{ marginBottom: 8 }}>
            <input value={crate.label} placeholder="CR-1" style={{ maxWidth: 100 }} className="mono"
              onChange={(e) => setCrate({ ...crate, label: e.target.value })} />
            <input value={crate.weight} placeholder="lb" inputMode="numeric" style={{ maxWidth: 80 }} className="mono"
              onChange={(e) => setCrate({ ...crate, weight: e.target.value })} />
            <button className="btn sm" disabled={pending || !crate.label.trim()}
              onClick={() => { act(() => addRestorationCrate(projectId, crate.label, parseInt(crate.weight) || 0)); setCrate({ label: "", weight: "" }); }}>
              + Crate
            </button>
          </div>
        )}
        {data.manifest.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table className="t-body" style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>{["Component", "Serial", "Crate"].map((h) => (
                  <th key={h} className="t-meta mut" style={{ textAlign: "left", padding: 4, borderBottom: "1px solid var(--line)" }}>{h}</th>
                ))}</tr>
              </thead>
              <tbody>
                {data.manifest.map((m) => (
                  <tr key={m.assetId}>
                    <td style={{ padding: 8, borderBottom: "1px solid var(--bg)" }}>{m.label}</td>
                    <td className="mono t-small" style={{ padding: 8, borderBottom: "1px solid var(--bg)" }}>{m.serial}</td>
                    <td style={{ padding: 8, borderBottom: "1px solid var(--bg)" }}>
                      <select value={m.crateId || ""} disabled={!canEdit || pending} style={{ maxWidth: 140 }}
                        onChange={(e) => act(() => assignComponentCrate(projectId, m.assetId, parseInt(e.target.value) || 0))}>
                        <option value="">— unassigned</option>
                        {data.crateList.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mut t-body">No serialized components to crate.</div>
        )}
        <div className="cred-note" style={{ marginTop: 8 }}>
          The gate passes when every serial above rides exactly one crate.
        </div>
      </section>

      <section className="card">
        <h2 className="card-title">Carrier &amp; cover <span className="eyebrow">the money part</span></h2>
        <div className="pf2" style={{ marginBottom: 8 }}>
          <div>
            <label>Carrier</label>
            <input value={draft.carrier} disabled={!canEdit} placeholder="XPO — liftgate service"
              onChange={(e) => setDraft({ ...draft, carrier: e.target.value })} />
          </div>
          <div>
            <label>Tracking</label>
            <input className="mono" value={draft.trackingNumber} disabled={!canEdit}
              onChange={(e) => setDraft({ ...draft, trackingNumber: e.target.value })} />
          </div>
        </div>
        <div className="pf3" style={{ marginBottom: 8 }}>
          <div>
            <label>Declared value ($)</label>
            <input className="mono" inputMode="decimal" value={draft.declaredValue} disabled={!canEdit}
              placeholder="68000" onChange={(e) => setDraft({ ...draft, declaredValue: e.target.value })} />
          </div>
          <div>
            <label>Pickup (YYYY-MM-DD)</label>
            <input className="mono" value={draft.pickupOn} disabled={!canEdit} placeholder="2026-09-04"
              onChange={(e) => setDraft({ ...draft, pickupOn: e.target.value })} />
          </div>
          <div>
            <label>Window / note</label>
            <input value={draft.pickupNote} disabled={!canEdit} placeholder="AM window"
              onChange={(e) => setDraft({ ...draft, pickupNote: e.target.value })} />
          </div>
        </div>
        {canEdit && (
          <button className="btn primary" disabled={pending} onClick={save}>
            {pending ? "Saving…" : "Save shipment"}
          </button>
        )}
      </section>
    </>
  );
}
