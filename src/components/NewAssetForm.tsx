"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createAsset } from "@/app/actions";
import CatalogSelect from "./CatalogSelect";
import PickOrAdd from "./PickOrAdd";

const empty = { kind: "Pump", model: "", serial: "", manufacturer: "", owner: "", asFound: "", location: "", note: "" };

/**
 * Add stock straight to the registry - a unit that was just bought and is on
 * the shelf, with no system to attach it to yet. It lands as a Spare and can be
 * installed into a system later (from here or from the system's Assets section).
 */
export default function NewAssetForm({ owners, kinds, models }: {
  owners: string[]; kinds: string[];
  // Catalog models per type - the only source; no free text (see CatalogSelect).
  models: Record<string, string[]>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<typeof empty>(empty);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [pending, startTransition] = useTransition();

  const submit = () => {
    setError("");
    startTransition(async () => {
      const res = await createAsset(null, draft);
      if (res?.error) { setError(res.error); return; }
      setSaved(`Added ${draft.kind} ${draft.model || draft.serial} to stock`);
      setDraft({ ...empty, kind: draft.kind, owner: draft.owner, location: draft.location });
      setTimeout(() => setSaved(""), 4000);
      router.refresh();
    });
  };

  return (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button className="btn sm primary" onClick={() => { setOpen((v) => !v); setError(""); }}>
          {open ? "Cancel" : "+ New asset"}
        </button>
        {saved && <span style={{ fontSize: 12, color: "#2E6B2E", fontWeight: 700 }}>{saved} ✓</span>}
      </div>

      {open && (
        <div className="dash-form" style={{ flexBasis: "100%", marginBottom: 0 }}>
          <div className="mut" style={{ fontSize: 12, marginBottom: 8 }}>
            Goes onto the shelf as a spare - no system needed. Attach it to one whenever it&apos;s used.
          </div>
          <div className="pf3" style={{ marginBottom: 8 }}>
            <div>
              <label>Type</label>
              <CatalogSelect value={draft.kind} options={kinds} ariaLabel="Asset type"
                onChange={(kind) => setDraft({ ...draft, kind, model: "" })}
                hint="Define module types in Settings → Catalog" />
            </div>
            <div>
              <label>Model</label>
              <CatalogSelect value={draft.model} options={models[draft.kind] ?? []} ariaLabel="Model"
                onChange={(model) => setDraft({ ...draft, model })}
                hint={`No ${draft.kind || "?"} models defined yet - add them in Settings → Catalog`} />
            </div>
            <div><label>Serial #</label><input className="mono" value={draft.serial} onChange={(e) => setDraft({ ...draft, serial: e.target.value })} placeholder="L20304512345" /></div>
          </div>
          <div className="pf3" style={{ marginBottom: 8 }}>
            <div><label>Manufacturer</label><input value={draft.manufacturer} onChange={(e) => setDraft({ ...draft, manufacturer: e.target.value })} placeholder="Shimadzu" /></div>
            <div>
              <label>Owner</label>
              <PickOrAdd value={draft.owner} options={owners} newLabel="+ New owner..." placeholder="Client name"
                onChange={(owner) => setDraft({ ...draft, owner })} />
            </div>
            <div><label>Where it is</label><input value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })} placeholder="Warehouse, shelf B" /></div>
          </div>
          <div style={{ marginBottom: 8 }}>
            <label>As found (optional)</label>
            <input value={draft.asFound} onChange={(e) => setDraft({ ...draft, asFound: e.target.value })}
              placeholder='Condition on arrival, e.g. "boxed, unopened"' />
          </div>
          <div style={{ marginBottom: 10 }}>
            <label>Note</label>
            <input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              placeholder='e.g. "bought Aug 7, PO SS-1102, still boxed"' />
          </div>
          {error && <div style={{ fontSize: 12, color: "#A32D2D", marginBottom: 8 }}>{error}</div>}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button className="btn sm accent" onClick={submit} disabled={pending || (!draft.model.trim() && !draft.serial.trim())}>
              {pending ? "Saving..." : "Add to stock"}
            </button>
            <button className="btn sm" onClick={() => { setOpen(false); setDraft(empty); }} disabled={pending}>Done</button>
            <span className="mut" style={{ fontSize: 11 }}>Type, owner and location stay put so a shipment goes in fast.</span>
          </div>
        </div>
      )}
    </>
  );
}
