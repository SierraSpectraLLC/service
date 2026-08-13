"use client";

import { promptReason } from "@/lib/reason";
import { useOptimistic, useState, useTransition } from "react";
import StagePanel, { type StageDefLite } from "./StagePanel";
import GasPanel, { type GasRow } from "./GasPanel";
import PickOrAdd from "./PickOrAdd";
import CatalogSelect from "./CatalogSelect";
import SharePanel, { type ShareEntry } from "./SharePanel";
import PhotoThumb from "./PhotoThumb";
import AccessRequestsPanel, { type AccessRequestRow } from "./AccessRequestsPanel";
import SalePanel from "./SalePanel";
import { updateInstrument, updateInstrumentNotes, deleteInstrument, setInstrumentLead, setInstrumentArchived } from "@/app/actions";

type Inst = {
  id: number; externalId: string; client: string; category: string; priority: number;
  lead: string; notes: string; archived: boolean; archivedBy: string;
  location: string; name: string;
  forSale: boolean; saleNote: string; listingToken: string;
  /**
   * Where to fetch the picture that represents the system: its cover photo, or
   * the catalog's photo of this system type while nobody has photographed it.
   * Blank for neither. See lib/photos.
   */
  photoSrc: string;
  /** How that photo sits in its tile. See lib/photoFrame. */
  photoFraming: string;
  /** True while the picture is the catalog's rather than this system's. */
  photoIsStock: boolean;
};

function LeadSelect({ instrumentId, lead, people }: { instrumentId: number; lead: string; people: string[] }) {
  const [, startTransition] = useTransition();
  const [value, setOptimistic] = useOptimistic(lead, (_cur: string, next: string) => next);
  const options = ["", ...people, ...(value && !people.includes(value) ? [value] : [])];
  return (
    <select value={value}
      onChange={(e) => startTransition(async () => { setOptimistic(e.target.value); await setInstrumentLead(instrumentId, e.target.value); })}
      style={{ width: "auto", fontWeight: 700, fontSize: 12 }}>
      {options.map((p) => <option key={p} value={p}>{p || "-"}</option>)}
    </select>
  );
}

export default function SystemPanel({ instrument, label, clients, categories, stages, stageDefs, gases, knownGases, people, shares, orgOptions, accessRequests, ownerOrgId, canEdit, isStaff, isOwner, canSell }: {
  // `label` is composed from the system's assets - see lib/systemLabel.ts.
  instrument: Inst; label: string; clients: string[]; categories: string[];
  stages: string[]; stageDefs: StageDefLite[];
  gases: GasRow[]; knownGases: string[]; people: string[];
  shares: ShareEntry[]; orgOptions: { id: number; name: string; kind: string }[];
  accessRequests: AccessRequestRow[]; ownerOrgId: number | null;
  canEdit: boolean; isStaff: boolean; isOwner: boolean;
  /** Staff or the owning org's editors: may list the system for sale. */
  canSell: boolean;
  /** Today's client-report line, when the EOD module is on and the viewer may see it. */
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ externalId: "", client: "", category: "", priority: "", notes: "", location: "", name: "" });
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const openEdit = () => {
    setDraft({
      externalId: instrument.externalId, client: instrument.client, category: instrument.category,
      priority: String(instrument.priority), notes: instrument.notes, location: instrument.location,
      name: instrument.name,
    });
    setError("");
    setEditing(true);
  };

  const save = () => {
    setError("");
    startTransition(async () => {
      if (canEdit) {
        const res = await updateInstrument(instrument.id, {
          externalId: draft.externalId, client: draft.client, category: draft.category,
          priority: parseInt(draft.priority) || instrument.priority,
          location: draft.location, name: draft.name,
        });
        if (res?.error) { setError(res.error); return; } // keep the form open with the bad value
      }
      if (draft.notes !== instrument.notes) await updateInstrumentNotes(instrument.id, draft.notes);
      setEditing(false);
    });
  };

  return (
    <div className="card">
      {instrument.archived && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", background: "#EEF1F5", border: "1px solid var(--line)", borderRadius: 8, padding: "8px 12px", marginBottom: 10 }}>
          <span className="pill" style={{ background: "#E2E8F0", color: "#475569" }}>Archived</span>
          <span className="mut" style={{ fontSize: 12 }}>
            Kept for the record{instrument.archivedBy ? ` · by ${instrument.archivedBy}` : ""} · hidden from the dashboard, EOD, and sheet parity.
          </span>
          {canEdit && (
            <button className="btn sm" style={{ marginLeft: "auto" }} disabled={pending}
              onClick={() => startTransition(() => setInstrumentArchived(instrument.id, false))}>Restore</button>
          )}
        </div>
      )}
      {/* Wrapping, not shrinking: on a phone the picture and the button would
          squeeze the name into a four-line column otherwise. */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
        {/* The whole bench, beside the numbers rather than above them - it is
            what somebody recognizes the system by. The rest are in Photos. */}
        {instrument.photoSrc && (
          <span style={{ flexShrink: 0 }}>
            <PhotoThumb src={instrument.photoSrc} framing={instrument.photoFraming}
              alt={`${instrument.externalId} - the system`} width={132} height={99} />
            {instrument.photoIsStock && (
              <div className="mut" style={{ fontSize: 10, marginTop: 2, textAlign: "center" }}>catalog photo</div>
            )}
          </span>
        )}
        <div style={{ flex: "1 1 190px", minWidth: 0 }}>
          <div className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--mut)" }}>
            {instrument.externalId} · {instrument.client} · Priority {instrument.priority}
          </div>
          {!editing && (
            <>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginTop: 2 }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: "var(--navy)" }}>
                  {label || <span className="mut" style={{ fontWeight: 400, fontSize: 15 }}>No assets listed yet</span>}
                </div>
                {instrument.category && (
                  <span className="pill" style={{ background: "#E7F2FA", color: "#1D6396" }}>{instrument.category}</span>
                )}
                {instrument.forSale && (
                  <span className="pill" style={{ background: "#E5F3E5", color: "#2E6B2E" }}>For sale</span>
                )}
              </div>
              {instrument.location && <div className="mut" style={{ fontSize: 12, marginTop: 2 }}>{instrument.location}</div>}
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                <span className="mut" style={{ fontSize: 12 }}>Lead:</span>
                {canEdit
                  ? <LeadSelect instrumentId={instrument.id} lead={instrument.lead} people={people} />
                  : <span style={{ fontSize: 12, fontWeight: 700, color: instrument.lead ? "var(--navy)" : "var(--mut)" }}>{instrument.lead || "-"}</span>}
              </div>
              <div className="mut" style={{ fontSize: 13, marginTop: 6, whiteSpace: "pre-wrap" }}>{instrument.notes || "No notes."}</div>
            </>
          )}
        </div>
        {canEdit && !editing && (
          <button className="btn sm" style={{ flexShrink: 0 }} onClick={openEdit}>Edit system</button>
        )}
      </div>

      {editing && (
        <div className="dash-form" style={{ marginTop: 10, marginBottom: 0 }}>
          {canEdit && (
            <>
              <div className="pf3" style={{ marginBottom: 8 }}>
                <div>
                  <label>System ID *</label>
                  <input className="mono" value={draft.externalId} onChange={(e) => setDraft({ ...draft, externalId: e.target.value })} placeholder="X-004" />
                </div>
                <div>
                  <label>Client</label>
                  <PickOrAdd value={draft.client} options={clients} newLabel="+ New client..." placeholder="New client name"
                    onChange={(client) => setDraft({ ...draft, client })} />
                </div>
                <div><label>Priority</label><input value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })} /></div>
              </div>
              <div style={{ marginBottom: 8 }}>
                <label>Name</label>
                {/* Blank means "name it from the assets" - which is right until
                    seven LC modules make a paragraph of it. */}
                <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder={label || "Named from its assets"} />
                <div className="mut" style={{ fontSize: 11, marginTop: 2 }}>
                  {draft.name.trim()
                    ? "Yours - the assets will never overwrite it."
                    : `Empty, so it's named from its assets: ${label || "nothing listed yet"}`}
                </div>
              </div>
              <div className="pf2" style={{ marginBottom: 8 }}>
                <div>
                  <label>Category</label>
                  <CatalogSelect value={draft.category} options={categories} ariaLabel="System category"
                    onChange={(category) => setDraft({ ...draft, category })} />
                </div>
                <div>
                  <label>Location</label>
                  <input value={draft.location} onChange={(e) => setDraft({ ...draft, location: e.target.value })} placeholder="Corner room, bench 3" />
                </div>
              </div>
            </>
          )}
          <div style={{ marginBottom: 10 }}>
            <label>Notes</label>
            <textarea value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} rows={3}
              placeholder='Current state of the system, e.g. "No Helium - waiting on refill"' style={{ resize: "vertical" }} />
          </div>
          {error && <div style={{ fontSize: 12, color: "#A32D2D", marginBottom: 8 }}>{error}</div>}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button className="btn sm accent" onClick={save} disabled={pending}>{pending ? "Saving..." : "Save changes"}</button>
            <button className="btn sm" onClick={() => setEditing(false)} disabled={pending}>Cancel</button>
            {!instrument.archived && (
              <button className="btn sm" style={{ marginLeft: "auto" }} disabled={pending}
                onClick={() => {
                  if (!window.confirm(`Archive ${instrument.externalId}? It keeps all its history and can be restored any time.`)) return;
                  startTransition(() => setInstrumentArchived(instrument.id, true));
                }}>Archive</button>
            )}
            {isOwner && (
              <button
                className="btn link" style={{ color: "#A32D2D", fontSize: 12, fontWeight: 700 }}
                onClick={() => {
                  const typed = window.prompt(
                    `This permanently deletes ${instrument.externalId} with all its tasks, parts, gases and attachments.\n\nType ${instrument.externalId} to confirm:`
                  );
                  if (typed !== instrument.externalId) return;
                  const reason = promptReason(`Deleting ${instrument.externalId}.`);
                  if (!reason) return;
                  startTransition(async () => { await deleteInstrument(instrument.id, reason); });
                }}
              >Delete system</button>
            )}
          </div>
        </div>
      )}

      <StagePanel instrumentId={instrument.id} stages={stages} stageDefs={stageDefs} canEdit={canEdit} />
      <GasPanel target={{ instrumentId: instrument.id, assetId: null }} gases={gases} knownGases={knownGases} canEdit={canEdit} isStaff={isStaff} />
      <SharePanel targetId={instrument.id} shares={shares} orgOptions={orgOptions} ownerOrgId={ownerOrgId}
        canManageAll={isStaff} canAddProvider={!isStaff && canEdit} />
      <AccessRequestsPanel requests={accessRequests} isOperator={isStaff} />
      {canSell && (
        <SalePanel targetId={instrument.id} forSale={instrument.forSale}
          saleNote={instrument.saleNote} listingToken={instrument.listingToken} />
      )}
    </div>
  );
}
