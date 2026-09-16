"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createAsset } from "@/app/actions";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import CatalogSelect from "./CatalogSelect";
import PickOrAdd from "./PickOrAdd";
import { orgNamed, type OrgLite } from "@/lib/owner";

const empty = { kind: "Pump", model: "", serial: "", manufacturer: "", owner: "", asFound: "", location: "", note: "" };

/**
 * Add stock straight to the registry - a unit that was just bought and is on
 * the shelf, with no system to attach it to yet. It lands as a Spare and can be
 * installed into a system later (from here or from the system's Assets section).
 */
export default function NewAssetForm({ owners, kinds, models, owner, label }: {
  /** The organizations a unit may belong to - see lib/owner.ownerChoices. */
  owners: OrgLite[]; kinds: string[];
  // Catalog models per type - the only source; no free text (see CatalogSelect).
  models: Record<string, string[]>;
  /**
   * Whose unit it is, when the page already knows - a client's own Fleet tab
   * does. The owner picker goes away and every unit added here lands as
   * theirs, which is the step that got forgotten when the only door was the
   * registry's own form.
   */
  owner?: OrgLite;
  /** What the button says. "+ New asset" on the registry; "+ Unit" on a fleet. */
  label?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const blank = owner ? { ...empty, owner: owner.name } : empty;
  const [draft, setDraft] = useState<typeof empty>(blank);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [pending, startTransition] = useTransition();

  // The first unmet requirement, in plain words, live in the footer.
  const problem = !draft.model.trim() && !draft.serial.trim() ? "give it a model or a serial number" : null;

  const submit = () => {
    setError("");
    startTransition(async () => {
      // Picked off the organization list, the owner is linked as well as
      // named; typed freehand it is a name only (a company not on the platform).
      const res = await createAsset(null, {
        ...draft,
        ownerOrgId: owner ? owner.id : orgNamed(draft.owner, owners)?.id ?? null,
      });
      if (res?.error) { setError(res.error); return; }
      setSaved(`Added ${draft.kind} ${draft.model || draft.serial} to stock`);
      setDraft({ ...blank, kind: draft.kind, owner: draft.owner, location: draft.location });
      setTimeout(() => setSaved(""), 4000);
      router.refresh();
    });
  };

  return (
    <>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button className="btn sm primary" onClick={() => { setOpen((v) => !v); setError(""); }}>
          {open ? "Cancel" : label ?? "+ New asset"}
        </button>
        {saved && <span className="t-small" style={{ color: "var(--t-good-fg)", fontWeight: 700 }}>{saved} ✓</span>}
      </div>

      {open && (
        <Dialog open onClose={() => { setOpen(false); setDraft(blank); }} title={owner ? `New unit for ${owner.name}` : "New asset"}
          context={owner
            ? `Lands as ${owner.name}'s, on the shelf as a spare. Install it into one of their systems whenever it is used.`
            : "Goes onto the shelf as a spare - no system needed. Attach it to one whenever it's used."}
          footer={
            <>
              <DialogStatus error={error} problem={problem}
                ok={saved ? `${saved} ✓` : "Type, owner and location stay put so a shipment goes in fast."} />
              <button className="btn" onClick={() => { setOpen(false); setDraft(blank); }} disabled={pending}>Done</button>
              <button className="btn accent" onClick={submit} disabled={pending || !!problem}>
                {pending ? "Saving..." : "Add to stock"}
              </button>
            </>
          }>
          <div className="dialog-section">What it is</div>
          <div className="pf3" style={{ marginBottom: 8 }}>
            <div>
              <label>Type</label>
              <CatalogSelect value={draft.kind} options={kinds} ariaLabel="Asset type"
                onChange={(kind) => setDraft({ ...draft, kind, model: "" })}
                hint="Define module types in Settings → Catalog" />
            </div>
            <div>
              <label>Model</label>
              <CatalogSelect value={draft.model} options={models[draft.kind] ?? []} ariaLabel="Model" allowNew="+ New model..."
                onChange={(model) => setDraft({ ...draft, model })}
                hint={`No ${draft.kind || "?"} models defined yet - add them in Settings → Catalog`} />
            </div>
            <div><label>Serial #</label><input className="mono" value={draft.serial} onChange={(e) => setDraft({ ...draft, serial: e.target.value })} placeholder="L20304512345" /></div>
          </div>
          <div className="dialog-section">Where it&apos;s from</div>
          <div className="pf3" style={{ marginBottom: 8 }}>
            <div><label>Manufacturer</label><input value={draft.manufacturer} onChange={(e) => setDraft({ ...draft, manufacturer: e.target.value })} placeholder="Shimadzu" /></div>
            <div>
              <label>Owner</label>
              {owner
                ? <div className="t-body" style={{ paddingTop: 6, fontWeight: 600 }}>{owner.name}</div>
                : (
                  <PickOrAdd value={draft.owner} options={owners.map((o) => o.name)} newLabel="+ New owner..." placeholder="Client name"
                    onChange={(who) => setDraft({ ...draft, owner: who })} />
                )}
            </div>
            <div><label>Where it is</label><input value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })} placeholder="Warehouse, shelf B" /></div>
          </div>
          <div className="dialog-section">Condition</div>
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
        </Dialog>
      )}
    </>
  );
}
