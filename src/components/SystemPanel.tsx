"use client";

import { confirmDialog, confirmReason, inputDialog } from "@/components/ui/ConfirmDialog";
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
import { STANDING_TONE } from "@/lib/gxp";
import Dialog from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";

type Inst = {
  id: number; externalId: string; client: string; category: string; priority: number;
  gxp: boolean;
  lead: string; notes: string; archived: boolean; archivedBy: string;
  /** Why it is blocked, while it is. See lib/stages and StagePanel. */
  blockedReason: string;
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
      className="t-small" style={{ width: "auto", fontWeight: 700 }}>
      {options.map((p) => <option key={p} value={p}>{p || "-"}</option>)}
    </select>
  );
}

export default function SystemPanel({ instrument, label, clients, categories, stages, stageDefs, gases, knownGases, people, shares, orgOptions, accessRequests, ownerOrgId, canEdit, isStaff, isOwner, canSell, gxpStanding }: {
  // `label` is composed from the system's assets - see lib/systemLabel.ts.
  instrument: Inst; label: string; clients: string[]; categories: string[];
  stages: string[]; stageDefs: StageDefLite[];
  gases: GasRow[]; knownGases: string[]; people: string[];
  shares: ShareEntry[]; orgOptions: { id: number; name: string; kind: string }[];
  accessRequests: AccessRequestRow[]; ownerOrgId: number | null;
  canEdit: boolean; isStaff: boolean; isOwner: boolean;
  /** Staff or the owning org's editors: may list the system for sale. */
  canSell: boolean;
  /** Derived qualification standing - null on unregulated systems. See lib/gxp. */
  gxpStanding: { label: string; tone: "ok" | "warn" | "bad"; reasons: string[] } | null;
  /** Today's client-report line, when the EOD module is on and the viewer may see it. */
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ externalId: "", client: "", category: "", priority: "", notes: "", location: "", name: "", gxp: false });
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const openEdit = () => {
    setDraft({
      externalId: instrument.externalId, client: instrument.client, category: instrument.category,
      priority: String(instrument.priority), notes: instrument.notes, location: instrument.location,
      name: instrument.name, gxp: instrument.gxp,
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
          location: draft.location, name: draft.name, gxp: draft.gxp,
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
          <span className="pill neutral">Archived</span>
          <span className="mut t-small">
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
          {/* Each fact holds together on a narrow screen. Left to wrap freely
              this line broke between "Priority" and its number, which reads as a
              rendering fault rather than as a line that ran out of room. */}
          <div className="mono t-small" style={{ fontWeight: 700, color: "var(--mut)" }}>
            <span style={{ whiteSpace: "nowrap" }}>{instrument.externalId}</span>
            {instrument.client && <> · <span style={{ whiteSpace: "nowrap" }}>{instrument.client}</span></>}
            {" · "}<span style={{ whiteSpace: "nowrap" }}>Priority {instrument.priority}</span>
          </div>
          {!editing && (
            <>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginTop: 2 }}>
                <div style={{ fontSize: 18, fontWeight: 700, color: "var(--navy)" }}>
                  {label || <span className="mut" style={{ fontWeight: 400, fontSize: 15 }}>No assets listed yet</span>}
                </div>
                {instrument.category && (
                  <span className="pill info">{instrument.category}</span>
                )}
                {/* The one-glance answer a regulated system owes: qualified or
                    not, with the reasons on hover. Unregulated systems show
                    nothing - the flag gates every compliance surface. */}
                {instrument.gxp && gxpStanding && (
                  <span className={`pill ${STANDING_TONE[gxpStanding.tone]}`}
                    title={gxpStanding.reasons.join("; ") || "All qualification work complete, nothing expiring"}>
                    GxP · {gxpStanding.label}
                  </span>
                )}
                {instrument.forSale && (
                  <span className="pill good">For sale</span>
                )}
              </div>
              {instrument.location && <div className="mut t-small" style={{ marginTop: 2 }}>{instrument.location}</div>}
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
                <span className="mut t-small">Lead:</span>
                {canEdit
                  ? <LeadSelect instrumentId={instrument.id} lead={instrument.lead} people={people} />
                  : <span className="t-small" style={{ fontWeight: 700, color: instrument.lead ? "var(--navy)" : "var(--mut)" }}>{instrument.lead || "-"}</span>}
              </div>
              <div className="mut t-body" style={{ marginTop: 6, whiteSpace: "pre-wrap" }}>{instrument.notes || "No notes."}</div>
            </>
          )}
        </div>
        {canEdit && !editing && (
          <button className="btn sm" style={{ flexShrink: 0 }} onClick={openEdit}>Edit system</button>
        )}
      </div>

      {editing && (
        <Dialog open onClose={() => setEditing(false)} title={`Edit ${instrument.externalId}`}
          footer={
            <>
              <span className={`dialog-status${error ? " err" : ""}`}>{error}</span>
              {!instrument.archived && (
                <button className="btn" disabled={pending}
                  onClick={async () => {
                    if (!(await confirmDialog({
                      title: `Archive ${instrument.externalId}?`,
                      body: "It keeps all its history and can be restored any time. It leaves the dashboard, EOD, and sheet parity.",
                      action: `Archive ${instrument.externalId}`,
                    }))) return;
                    startTransition(async () => {
                      await setInstrumentArchived(instrument.id, true);
                      toast({
                        message: `Archived ${instrument.externalId}`,
                        undo: () => { void setInstrumentArchived(instrument.id, false); },
                      });
                    });
                  }}>Archive</button>
              )}
              {isOwner && (
                <button className="btn link danger"
                  onClick={async () => {
                    const typed = await inputDialog({
                      title: `Delete ${instrument.externalId}?`,
                      body: `This permanently deletes ${instrument.externalId} with all its tasks, parts, gases and attachments.`,
                      action: "Delete", tone: "bad",
                      label: `Type ${instrument.externalId} to confirm`,
                    });
                    if (typed !== instrument.externalId) return;
                    const reason = await confirmReason({
                      title: `Why is ${instrument.externalId} being deleted?`,
                      body: "Recorded with the deletion in the audit trail.",
                      action: "Delete system", tone: "bad",
                    });
                    if (!reason) return;
                    startTransition(async () => { await deleteInstrument(instrument.id, reason); });
                  }}
                >Delete system</button>
              )}
              <button className="btn" onClick={() => setEditing(false)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={save} disabled={pending}>{pending ? "Saving..." : "Save changes"}</button>
            </>
          }>
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
                  {/* Two different facts, and the label is the one that does not
                      grant anything. Said here because "Client" reads like
                      ownership to anybody who has not been told otherwise. */}
                  <div className="mut t-meta" style={{ marginTop: 3 }}>
                    Who the work is for. Ownership is under Sharing, and follows a handoff on its own.
                  </div>
                </div>
                <div><label>Priority</label><input value={draft.priority} onChange={(e) => setDraft({ ...draft, priority: e.target.value })} /></div>
              </div>
              <div style={{ marginBottom: 8 }}>
                <label>Name</label>
                {/* Blank means "name it from the assets" - which is right until
                    seven LC modules make a paragraph of it. */}
                <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  placeholder={label || "Named from its assets"} />
                <div className="mut t-meta" style={{ marginTop: 2 }}>
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
              <label className="t-small" style={{ display: "flex", alignItems: "center", gap: 6, margin: "0 0 8px" }}>
                <input type="checkbox" checked={draft.gxp} style={{ width: 15, height: 15 }}
                  onChange={(e) => setDraft({ ...draft, gxp: e.target.checked })} />
                Regulated (GxP)
                <span className="mut" style={{ fontWeight: 400 }}>
                  - tracks qualification standing, validation documents and expiring certs
                </span>
              </label>
            </>
          )}
          <div style={{ marginBottom: 10 }}>
            <label>Notes</label>
            <textarea value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} rows={3}
              placeholder='Current state of the system, e.g. "No Helium - waiting on refill"' style={{ resize: "vertical" }} />
          </div>
        </Dialog>
      )}

      <StagePanel instrumentId={instrument.id} stages={stages} stageDefs={stageDefs} canEdit={canEdit}
        blockedReason={instrument.blockedReason} />
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
