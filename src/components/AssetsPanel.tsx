"use client";

import { Fragment, useState, useTransition } from "react";
import Link from "next/link";
import { ASSET_TONE } from "@/lib/stages";
import Dialog from "@/components/ui/Dialog";
import { createAsset, attachAssets } from "@/app/actions";
import { servesLine } from "@/lib/assetServes";
import CatalogSelect from "./CatalogSelect";
import SpecTable from "./SpecTable";
import AssetGrid, { type GridModel } from "./AssetGrid";
import PhotoThumb from "./PhotoThumb";
import { matchesQuery } from "@/lib/search";

export type AssetRow = {
  id: number; kind: string; model: string; serial: string; status: string; note: string; openItems: number;
  /** The module this one serves, and what it does for it. See lib/assetServes. */
  servesAssetId?: number | null;
  servesRole?: string;
  /**
   * Where to fetch this module's picture: its own cover photo, or the catalog's
   * stock photo of the model when nobody has photographed this one. Blank for a
   * unit with neither - a row with no thumbnail beats a row with a grey box.
   */
  photoSrc?: string;
  /** How that photo sits in a tile this small. See lib/photoFrame. */
  photoFraming?: string;
  /** The model's spec sheet (lib/modelSpecs), for the row's fold-out. */
  specs?: { name: string; value: string }[];
  specTermId?: number | null;
};

const empty = { kind: "Pump", model: "", serial: "", manufacturer: "", owner: "", asFound: "", location: "", note: "" };

export default function AssetsPanel({ instrumentId, assets, unassigned, kinds, canEdit, catalogModels, gridModels, owners, makers, staff }: {
  // `unassigned`: every asset not currently on a system (spares, shelf stock).
  instrumentId: number; assets: AssetRow[]; unassigned: { id: number; label: string }[];
  kinds: string[]; canEdit: boolean;
  // Catalog models already narrowed to this system's type, keyed by asset type,
  // so the Model field suggests the right kit instead of every model in the shop.
  catalogModels: Record<string, string[]>;
  /** The same models with their makers, for the grid's Mfr column. */
  gridModels: Record<string, GridModel[]>;
  owners: string[];
  /** The maker/vendor book (Settings → Catalog), suggested on the Manufacturer field. */
  makers?: string[];
  /** Staff get the "full sheet" link into /catalog; clients can't open it. */
  staff?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [grid, setGrid] = useState(false);
  const [picking, setPicking] = useState(false);
  const [checked, setChecked] = useState<number[]>([]);
  const [filter, setFilter] = useState("");
  const [draft, setDraft] = useState<typeof empty>(empty);
  // Which rows have their spec sheet unfolded.
  const [specsOpen, setSpecsOpen] = useState<number[]>([]);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const submit = () => {
    setError("");
    startTransition(async () => {
      const res = await createAsset(instrumentId, draft);
      if (res?.error) setError(res.error);
      else { setDraft(empty); setOpen(false); }
    });
  };

  const attachChecked = () => {
    if (!checked.length) return;
    setError("");
    startTransition(async () => {
      const res = await attachAssets(checked, instrumentId);
      if (res?.error) setError(res.error);
      if (res?.attached) { setChecked([]); setPicking(false); }
    });
  };

  const shown = unassigned.filter((s) => matchesQuery(filter, [s.label]));

  if (!canEdit && assets.length === 0) return null;

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <div className="card-title">Assets</div>
        {canEdit && (
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
            {unassigned.length > 0 && (
              <button className="btn sm" onClick={() => { setPicking((v) => !v); setOpen(false); }}>
                {picking ? "Cancel" : "Add existing"}
              </button>
            )}
            <button className="btn sm" onClick={() => { setGrid((v) => !v); setOpen(false); setPicking(false); }}>
              {grid ? "Cancel" : "＋ Several"}
            </button>
            <button className="btn sm primary" onClick={() => { setOpen((v) => !v); setPicking(false); setGrid(false); }}>
              {open ? "Cancel" : "+ New asset"}
            </button>
          </div>
        )}
      </div>

      {picking && (
        <Dialog open onClose={() => setPicking(false)} title="Add existing assets"
          context="Check everything going into this system."
          footer={
            <>
              <span className="dialog-status" />
              <button className="btn" onClick={() => setPicking(false)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={attachChecked} disabled={pending || !checked.length}>
                {pending ? "Adding..." : `Add ${checked.length || ""} asset${checked.length === 1 ? "" : "s"}`.replace("  ", " ")}
              </button>
            </>
          }>
          {unassigned.length > 6 && (
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by type, model or serial..."
              style={{ marginBottom: 6, fontSize: 12 }} />
          )}
          <div style={{ maxHeight: 220, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 8, background: "#fff", padding: 4, marginBottom: 8 }}>
            {shown.map((s) => (
              <label key={s.id} className="row-hover"
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 6px", fontSize: 13, fontWeight: 400, color: "var(--ink)", margin: 0, textTransform: "none", letterSpacing: 0 }}>
                <input type="checkbox" checked={checked.includes(s.id)} style={{ width: 15, height: 15, flexShrink: 0 }}
                  onChange={(e) => setChecked((c) => (e.target.checked ? [...c, s.id] : c.filter((x) => x !== s.id)))} />
                {s.label}
              </label>
            ))}
            {shown.length === 0 && <div className="mut" style={{ fontSize: 12, padding: 6 }}>Nothing matches.</div>}
          </div>
        </Dialog>
      )}

      {grid && (
        <div className="dash-form">
          <div className="panel-head"><span className="card-title">Add several units</span></div>
          <div className="panel-hint">A row per unit; paste a block straight from a spreadsheet.</div>
          <AssetGrid instrumentId={instrumentId} kinds={kinds} models={gridModels} owners={owners}
            onDone={() => setGrid(false)} />
        </div>
      )}

      {open && (
        <Dialog open onClose={() => setOpen(false)} title="Add a unit"
          footer={
            <>
              <span className={`dialog-status${error ? " err" : ""}`}>{error}</span>
              <button className="btn" onClick={() => setOpen(false)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={submit} disabled={pending || (!draft.model.trim() && !draft.serial.trim())}>
                {pending ? "Saving..." : "Add asset"}
              </button>
            </>
          }>
          <div className="pf3" style={{ marginBottom: 8 }}>
            <div>
              <label>Type</label>
              <CatalogSelect value={draft.kind} options={kinds} ariaLabel="Asset type"
                onChange={(kind) => setDraft({ ...draft, kind, model: "" })}
                hint="Define module types in Settings → Catalog" />
            </div>
            <div>
              <label>Model</label>
              <CatalogSelect value={draft.model} options={catalogModels[draft.kind] ?? []} ariaLabel="Model" allowNew="+ New model..."
                onChange={(model) => setDraft({ ...draft, model })}
                hint={`No ${draft.kind || "?"} models for this system type yet - add them in Settings → Catalog`} />
            </div>
            <div><label>Serial #</label><input className="mono" value={draft.serial} onChange={(e) => setDraft({ ...draft, serial: e.target.value })} placeholder="L20304512345" /></div>
          </div>
          <div className="pf2" style={{ marginBottom: 10 }}>
            <div><label>Manufacturer</label><input value={draft.manufacturer} list="maker-book" onChange={(e) => setDraft({ ...draft, manufacturer: e.target.value })} placeholder="Shimadzu" />
              <datalist id="maker-book">{(makers ?? []).map((m) => <option key={m} value={m} />)}</datalist></div>
            <div><label>Note</label><input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder='e.g. "seals replaced Jul 24"' /></div>
          </div>
        </Dialog>
      )}
      {!open && error && <div style={{ fontSize: 12, color: "var(--t-bad-fg)", marginBottom: 8 }}>{error}</div>}

      {assets.length === 0 && !open && (
        <div className="mut" style={{ fontSize: 13 }}>No assets listed yet.</div>
      )}
      {assets.map((a) => {
        const statusTone = ASSET_TONE[a.status] ?? "neutral";
        // Read off the same list rather than fetched: the panel already has
        // every unit on this system, and who serves whom is among them.
        const serving = a.servesAssetId ? assets.find((x) => x.id === a.servesAssetId) : null;
        const servers = assets.filter((x) => x.servesAssetId === a.id);
        return (
          <Fragment key={a.id}>
          <Link href={`/assets/${a.id}`} className="row-hover"
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 4px", borderTop: "1px solid var(--line)", flexWrap: "wrap", textDecoration: "none", color: "inherit" }}>
            <span title={a.status} style={{ width: 10, height: 10, borderRadius: "50%", background: `var(--t-${statusTone}-fg)`, flexShrink: 0 }} />
            {/* A thumbnail here is what makes the list read as the bench rather
                than as a parts manifest. Absent for units without one, rather
                than a placeholder box per row. */}
            {a.photoSrc && (
              <PhotoThumb src={a.photoSrc} framing={a.photoFraming ?? ""} alt=""
                width={34} height={34} radius={6} />
            )}
            <span className="pill neutral">{a.kind}</span>
            <span style={{ fontSize: 13, fontWeight: 700 }}>{a.model || <span className="mut">(no model)</span>}</span>
            {a.serial && <span className="mono mut" style={{ fontSize: 12 }}>SN {a.serial}</span>}
            {a.status !== "In service" && <span className={`pill ${statusTone}`}>{a.status}</span>}
            {/* One line each way, so the stack reads as plumbed rather than as
                an alphabetical parts manifest. */}
            {serving && (
              <span className="mut" style={{ fontSize: 11.5 }}>
                → {serving.model || serving.serial || serving.kind}
                {a.servesRole ? ` (${a.servesRole})` : ""}
              </span>
            )}
            {servers.length > 0 && (
              <span className="mut" style={{ fontSize: 11.5 }}>
                {/* With the role, because two identical pumps on one spec read
                    as a stutter without it. */}
                ← {servesLine(servers.map((s) => ({ ...s, servesRole: s.servesRole ?? "" })))}
              </span>
            )}
            <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
              {(a.specs?.length ?? 0) > 0 && (
                /* Inside the row Link, so it can't be a button or an anchor -
                   it stops the navigation and unfolds the sheet below. */
                <span role="button" tabIndex={0} aria-expanded={specsOpen.includes(a.id)}
                  aria-label={`Specs for ${a.model || a.kind}`}
                  className="pill info" style={{ cursor: "pointer" }}
                  onClick={(e) => {
                    e.preventDefault(); e.stopPropagation();
                    setSpecsOpen((o) => (o.includes(a.id) ? o.filter((x) => x !== a.id) : [...o, a.id]));
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault(); e.stopPropagation();
                    setSpecsOpen((o) => (o.includes(a.id) ? o.filter((x) => x !== a.id) : [...o, a.id]));
                  }}>
                  specs {specsOpen.includes(a.id) ? "▴" : "▾"}
                </span>
              )}
              {a.openItems > 0 && <span className="pill warn">{a.openItems} open</span>}
              <span className="mut" style={{ fontSize: 12 }}>→</span>
            </span>
          </Link>
          {specsOpen.includes(a.id) && (a.specs?.length ?? 0) > 0 && (
            <div style={{ padding: "2px 8px 8px 32px", background: "#FBFDFF", borderTop: "1px dashed var(--line)" }}>
              <SpecTable specs={a.specs!} compact />
              {staff && a.specTermId != null && (
                <Link href={`/catalog/${a.specTermId}`} className="btn link" style={{ fontSize: 10 }}>full sheet →</Link>
              )}
            </div>
          )}
        </Fragment>
        );
      })}
    </div>
  );
}
