"use client";

import { confirmReason } from "@/components/ui/ConfirmDialog";
import { useMemo, useOptimistic, useState, useTransition } from "react";
import { CARRIERS, PART_STATES, PART_TONE, ORDER_STATES, trackUrl } from "@/lib/stages";
import { modelsForType, moduleTypeOptions, type CatalogModel } from "@/lib/moduleTypes";
import { intakeModule } from "@/app/actions";
import { parseSpecs, serializeSpecs, SPECS_MAX_PAIRS, type SpecPair } from "@/lib/partSpecs";
import {
  createPart, updatePart, setPartStatus, setPartAsset, deletePart, nameServiceVisit, type WorkTarget,
} from "@/app/actions";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { pricesFor, type PriceEntry } from "@/lib/priceBook";
import PartNumberField from "./PartNumberField";
import { formatCents, centsToInput } from "@/lib/money";
import { dayText, isoDay, partGroups, type ServiceEvent } from "@/lib/partGroups";

type Part = {
  id: number; kind: string; assetId: number | null; name: string; partNumber: string; serial: string; qty: string; specs: string;
  vendor: string; po: string; cost: string;
  carrier: string; tracking: string; orderedAt: string; eta: string; receivedAt: string;
  installedAt: string; removedAt: string; note: string; status: string; createdAt: string;
  /** Set on a part that came out of a kit - rendered under it, never on its own. */
  parentPartId?: number | null;
  /** The maintenance job this part belongs to, if somebody said. */
  pmScheduleId?: number | null;
  /** "Pump", "Autosampler"... - a UNIT on order, intaken as an asset on arrival. */
  moduleKind?: string;
};

function PartStatusSelect({ part }: { part: Part }) {
  const [, startTransition] = useTransition();
  const [status, setOptimistic] = useOptimistic(part.status, (_cur: string, next: string) => next);
  return (
    <select
      value={status}
      onChange={(e) => startTransition(async () => { setOptimistic(e.target.value); await setPartStatus(part.id, e.target.value); })}
      className="t-meta"
      style={{ width: "auto", fontWeight: 700, padding: "3px 6px", borderRadius: 999, background: `var(--t-${PART_TONE[status] ?? "neutral"}-bg)`, color: `var(--t-${PART_TONE[status] ?? "neutral"}-fg)`, cursor: "pointer" }}
    >
      {PART_STATES.map((s) => <option key={s}>{s}</option>)}
    </select>
  );
}

/** Row-level asset tag, editable in place - no need to open the full edit form. */
function PartAssetSelect({ part, systemAssets }: { part: Part; systemAssets: { id: number; label: string }[] }) {
  const [, startTransition] = useTransition();
  const [assetId, setOptimistic] = useOptimistic(part.assetId, (_cur: number | null, next: number | null) => next);
  return (
    <select
      value={assetId ?? ""}
      onChange={(e) => startTransition(async () => {
        const next = e.target.value ? parseInt(e.target.value) : null;
        setOptimistic(next);
        await setPartAsset(part.id, next);
      })}
      className="t-meta"
      style={{ width: "auto", fontWeight: 700, padding: "3px 6px", borderRadius: 999, background: assetId !== null ? "#EDEBFA" : "#EEF1F5", color: assetId !== null ? "#4F45A3" : "#475569", cursor: "pointer" }}
    >
      <option value="">Whole system</option>
      {systemAssets.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
    </select>
  );
}

const empty = { kind: "part", moduleKind: "", expandKit: true, pmScheduleId: null as number | null, assetId: null as number | null, name: "", partNumber: "", serial: "", qty: "", vendor: "", po: "", cost: "", carrier: "", tracking: "", orderedAt: "", eta: "", status: "Needed", note: "", installedAt: "", removedAt: "", requestReplacement: false };

const money = (s: string) => parseFloat(s.replace(/[^0-9.]/g, ""));

export default function PartsPanel({ target, parts, systemAssets, canEdit, isStaff, showCosts, priceBook = [], serviceEvents = [], visitNames = {}, pmJobs = [], moduleTypes = [], moduleModels = [] }: {
  target: WorkTarget; parts: Part[]; systemAssets: { id: number; label: string }[]; canEdit: boolean; isStaff: boolean;
  /** Jobs completed, by day, so a visit can be named after the work it was. */
  serviceEvents?: ServiceEvent[];
  /** Names somebody gave a day themselves, keyed YYYY-MM-DD. Beats the jobs. */
  visitNames?: Record<string, string>;
  // Cost and PO are the owner's business data: hidden (and blanked by the
  // server before they get here) for providers and other non-owner orgs.
  showCosts: boolean;
  // House price book entries; the server only sends these alongside showCosts.
  priceBook?: PriceEntry[];
  /**
   * Maintenance jobs on this record, so a part fitted during one can say so.
   * That attribution is what keeps a PM's own parts off the parts allowance on
   * a contract that includes them - see lib/agreementUsage.
   */
  pmJobs?: { id: number; title: string }[];
  /**
   * Module types from the shop's equipment catalog, for the Asset pill and the
   * intake picker. Empty falls back to the starter list.
   */
  moduleTypes?: string[];
  /**
   * The catalog's models, so choosing a module type can offer the units the
   * shop already knows by name instead of asking somebody to retype one.
   */
  moduleModels?: CatalogModel[];
}) {
  const assetLabel = (id: number | null) => systemAssets.find((a) => a.id === id)?.label ?? null;
  const [form, setForm] = useState<null | { mode: "new" } | { mode: "edit"; id: number }>(null);
  // The arrival dialog: the box is here, the unit joins the asset list. What
  // the order already knew arrives prefilled; the serial is the one thing only
  // the box can say, so it is the field the cursor lands in.
  const [intake, setIntake] = useState<null | { partId: number; moduleKind: string }>(null);
  const [intakeDraft, setIntakeDraft] = useState({
    kind: "", manufacturer: "", model: "", serial: "", location: "", replacesAssetId: "" as string,
  });
  const [intakeErr, setIntakeErr] = useState("");
  const openIntake = (p: Part) => {
    setIntakeDraft({
      kind: p.moduleKind ?? "", manufacturer: p.vendor, model: p.name,
      serial: p.serial, location: "", replacesAssetId: "",
    });
    setIntakeErr("");
    setIntake({ partId: p.id, moduleKind: p.moduleKind ?? "" });
  };
  const [draft, setDraft] = useState<typeof empty>(empty);
  const [specPairs, setSpecPairs] = useState<SpecPair[]>([]);
  const [flag, setFlag] = useState("");
  const [pending, startTransition] = useTransition();
  // Kept whole across a re-render so the second picker's options don't shuffle
  // under the finger while somebody is choosing from them.
  const arrivesTypes = useMemo(
    () => moduleTypeOptions(moduleTypes, draft.moduleKind),
    [moduleTypes, draft.moduleKind],
  );
  // A module type only means something under a system, so the fourth pill is
  // offered only where intake could actually land the unit.
  const canBeAsset = target.instrumentId !== null;
  // Which pill is lit. Reading it back off the draft is what makes an existing
  // row open on the right one without storing the answer twice.
  const pillKind = draft.moduleKind ? "asset" : draft.kind;
  const catalogModels = useMemo(
    () => modelsForType(moduleModels, draft.moduleKind),
    [moduleModels, draft.moduleKind],
  );

  // Which day's heading is being renamed, and to what.
  const [naming, setNaming] = useState<null | { day: string; title: string }>(null);

  const openNew = () => { setDraft(empty); setSpecPairs([]); setForm({ mode: "new" }); };
  const openEdit = (p: Part) => {
    // A date input only accepts a calendar day, so a row still carrying one of
    // the old year-less strings opens blank and says what is stored underneath.
    setDraft({ kind: p.kind, moduleKind: p.moduleKind ?? "", expandKit: false, pmScheduleId: p.pmScheduleId ?? null, assetId: p.assetId, name: p.name, partNumber: p.partNumber, serial: p.serial, qty: p.qty, vendor: p.vendor, po: p.po, cost: p.cost, carrier: p.carrier, tracking: p.tracking, orderedAt: p.orderedAt, eta: p.eta, status: p.status, note: p.note, installedAt: isoDay(p.installedAt), removedAt: isoDay(p.removedAt), requestReplacement: false });
    setSpecPairs(parseSpecs(p.specs));
    setForm({ mode: "edit", id: p.id });
  };
  const close = () => { setForm(null); setDraft(empty); setSpecPairs([]); };

  /**
   * The four pills, over the two fields that actually carry the answer.
   *
   * "Asset" is not a fourth parts.kind - it is a part that says what it
   * BECOMES, which is kind 'part' plus a module type. Keeping it a view over
   * those two columns means no migration, and every row already on file
   * classifies itself correctly the moment it is opened.
   *
   * Consumables usually come off the shelf and go straight in; everything else
   * starts as Needed.
   */
  const setKind = (kind: string) => {
    const asset = kind === "asset";
    setDraft((d) => ({
      ...d,
      kind: asset ? "part" : kind,
      moduleKind: asset ? (d.moduleKind || arrivesTypes[0] || "Other") : "",
      ...(form?.mode === "new" ? { status: kind === "consumable" ? "Installed" : "Needed" } : {}),
    }));
  };
  const setPair = (i: number, patch: Partial<SpecPair>) =>
    setSpecPairs((s) => s.map((p, idx) => (idx === i ? { ...p, ...patch } : p)));

  const editing = form?.mode === "edit" ? parts.find((p) => p.id === form.id) : undefined;

  // Dates matter once a row is finished, or about to be. Offered on the way in
  // too, so recording a swap a week later takes one form rather than two visits.
  const showServiceDates =
    draft.status === "Installed" || draft.status === "Removed"
    || !!(draft.installedAt || draft.removedAt || editing?.installedAt || editing?.removedAt);

  /** Say what a row is still carrying when a date input could not show it. */
  const legacy = (stored: string | undefined, shown: string) =>
    (stored && !isoDay(stored) && !shown
      ? <div className="mut t-meta" style={{ marginTop: 3 }}>recorded as &ldquo;{stored}&rdquo;</div>
      : null);

  // Order paperwork only matters once something is actually on order; keep the
  // fields visible when editing a row that already has them filled.
  const showOrderFields =
    (ORDER_STATES as readonly string[]).includes(draft.status) ||
    !!(draft.po || draft.carrier || draft.tracking || draft.orderedAt || draft.eta);

  const saveVisitName = (day?: string, title?: string) => {
    const d = day ?? naming?.day;
    if (!d) return;
    const t = title ?? naming?.title ?? "";
    startTransition(async () => {
      await nameServiceVisit(target, d, t);
      setNaming(null);
      toast({ message: t ? "Named the visit" : "Cleared the visit name" });
    });
  };

  const save = () => {
    if (!draft.name.trim() || !form) return;
    const payload = { ...draft, specs: serializeSpecs(specPairs) };
    startTransition(async () => {
      if (form.mode === "new") {
        const res = await createPart(target, payload);
        // Allowance heads-up rides the save; the record always lands. A kit
        // says how many parts came in with it, because that is the surprising
        // part of what just happened.
        const flagMsg = [
          res?.expanded ? `${res.expanded} part${res.expanded === 1 ? "" : "s"} from the kit recorded underneath it.` : "",
          res?.flag ?? "",
        ].filter(Boolean).join(" ");
        setFlag(flagMsg);
        if (!flagMsg) toast({ message: "Added the part" });
      } else { await updatePart(form.id, payload); toast({ message: "Saved the part" }); }
      close();
    });
  };

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
        <div className="card-title">Parts</div>
        {canEdit && (
          <button className="btn sm primary" style={{ marginLeft: "auto" }} onClick={() => (form ? close() : openNew())}>
            {form ? "Cancel" : "+ Add"}
          </button>
        )}
      </div>

      {flag && (
        <div className="t-small" style={{ padding: "8px 10px", borderRadius: 8, background: "#FAF0DC", color: "var(--t-warn-fg)", marginBottom: 8, display: "flex", gap: 8 }}>
          <span style={{ flex: 1 }}><b>Recorded.</b> {flag}</span>
          <button className="btn link" style={{ color: "var(--t-warn-fg)" }} onClick={() => setFlag("")}>dismiss</button>
        </div>
      )}

      {form && (
        <Dialog open onClose={close} size="lg" title={form.mode === "new" ? "New part" : "Edit part"}
          footer={
            <>
              <span className="dialog-status" />
              {form.mode === "edit" && isStaff && (
                <button className="btn link danger"
                  onClick={async () => {
                    const reason = await confirmReason({
                      title: `Delete part record "${draft.name}"?`,
                      body: "This removes it from the record entirely.",
                      action: "Delete", tone: "bad",
                    });
                    if (!reason) return;
                    startTransition(async () => { await deletePart((form as { id: number }).id, reason); close(); toast({ message: "Removed the part" }); });
                  }}
                >Remove</button>
              )}
              <button className="btn" onClick={close} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={save} disabled={pending}>
                {pending ? "Saving..." : form.mode !== "new" ? "Save changes"
                  // The pill decided what this is; the button that commits it
                  // should not go back to calling everything a part.
                  : pillKind === "asset" ? "Add unit"
                  : pillKind === "consumable" ? "Add consumable"
                  : pillKind === "kit" ? "Add kit" : "Add part"}
              </button>
            </>
          }>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
            <div style={{ display: "flex", gap: 4 }}>
              {[["part", "Part"], ["consumable", "Consumable"], ["kit", "Kit"],
                ...(canBeAsset ? [["asset", "Asset"]] : [])].map(([k, label]) => (
                <button key={k} className="pill" onClick={() => setKind(k)}
                  style={{
                    border: "none", cursor: "pointer",
                    background: pillKind === k ? "var(--navy)" : "#EEF1F5",
                    color: pillKind === k ? "#fff" : "#475569",
                  }}>{label}</button>
              ))}
            </div>
            {draft.kind === "consumable" && (
              <span className="mut t-meta">ferrules, septa, liners... defaults to Installed</span>
            )}
            {/* What kind of unit, and - if the catalog knows any - which one.
                Both sit with the pill that asked for them rather than as
                labelled fields further down, because neither exists unless
                this is an asset. */}
            {pillKind === "asset" && (
              <>
                <select value={draft.moduleKind} aria-label="Module type" className="t-small" style={{ width: "auto" }}
                  onChange={(e) => setDraft((d) => ({ ...d, moduleKind: e.target.value }))}>
                  {arrivesTypes.map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
                {catalogModels.length > 0 && (
                  <select aria-label="Catalog model" className="t-small" style={{ width: "auto" }}
                    value={catalogModels.some((m) => m.name === draft.name) ? draft.name : ""}
                    onChange={(e) => {
                      const pick = catalogModels.find((m) => m.name === e.target.value);
                      if (!pick) return;
                      // The name is the model; the maker only fills a blank,
                      // because vendor is who we BUY from and somebody may
                      // already have named a distributor.
                      setDraft((d) => ({ ...d, name: pick.name, vendor: d.vendor.trim() || pick.manufacturer }));
                    }}>
                    <option value="">Pick a model...</option>
                    {catalogModels.map((m) => (
                      <option key={`${m.manufacturer}/${m.name}`} value={m.name}>
                        {m.manufacturer ? `${m.manufacturer} ${m.name}` : m.name}
                      </option>
                    ))}
                  </select>
                )}
                <span className="mut t-meta">joins the asset list on arrival</span>
              </>
            )}
            {draft.kind === "kit" && (
              <>
                <span className="mut t-meta">the box as sold</span>
                <label style={{ display: "flex", gap: 6, alignItems: "center", margin: 0, fontSize: 12, fontWeight: 400, textTransform: "none", letterSpacing: 0, color: "var(--ink)", cursor: "pointer" }}>
                  <input type="checkbox" checked={draft.expandKit} style={{ width: 14, height: 14 }}
                    onChange={(e) => setDraft({ ...draft, expandKit: e.target.checked })} />
                  also record what&apos;s inside it
                </label>
              </>
            )}
          </div>
          <div className="pf2" style={{ marginBottom: 8 }}>
            <div style={{ gridColumn: "1 / -1" }}>
              <label>Name *</label>
              {/* The same book lookup the number field has, from the name side
                  - most people know what the thing is called, not its number. */}
              <PartNumberField value={draft.name} insert="name" className="" ariaLabel="Part name"
                placeholder={pillKind === "consumable" ? "e.g. Vespel ferrule 1/4in"
                  : pillKind === "asset" ? "e.g. TSQ 8000" : "e.g. 10kV HED supply"}
                onChange={(name) => setDraft({ ...draft, name })}
                onPick={(part) => setDraft((d) => ({
                  ...d,
                  kind: part.kind === "kit" && !d.moduleKind ? "kit" : d.kind,
                  name: part.name || part.partNumber,
                  partNumber: d.partNumber.trim() || part.partNumber,
                  vendor: d.vendor.trim() || part.vendor,
                  cost: d.cost.trim() || (part.priceCents !== null ? centsToInput(part.priceCents) : ""),
                }))} />
            </div>
            <div>
              <label>Part number</label>
              {/* Resolves against the parts book first: the name comes with it,
                  so a described part is never re-described by hand. */}
              <PartNumberField value={draft.partNumber} placeholder="G6303-80060" className=""
                onChange={(partNumber) => setDraft({ ...draft, partNumber })}
                onPick={(part) => setDraft((d) => ({
                  ...d,
                  // The book already knows this number is a kit; making
                  // somebody also say so is a question with a known answer.
                  kind: part.kind === "kit" && !d.moduleKind ? "kit" : d.kind,
                  partNumber: part.partNumber,
                  // Only into fields nobody has filled: a pick corrects the
                  // number, it does not overwrite what somebody typed.
                  name: d.name.trim() || part.name,
                  vendor: d.vendor.trim() || part.vendor,
                  cost: d.cost.trim() || (part.priceCents !== null ? centsToInput(part.priceCents) : ""),
                }))} />
            </div>
            <div><label>Serial #</label><input className="mono" value={draft.serial} onChange={(e) => setDraft({ ...draft, serial: e.target.value })} placeholder="US12345678" /></div>
            <div><label>Vendor</label><input value={draft.vendor} onChange={(e) => setDraft({ ...draft, vendor: e.target.value })} placeholder="Restek" /></div>
            <div><label>Qty</label><input value={draft.qty} onChange={(e) => setDraft({ ...draft, qty: e.target.value })} placeholder="1" /></div>
          </div>
          {showCosts && (() => {
            // Known offers for the PN as typed - tap one to fill vendor + cost.
            const offers = pricesFor(priceBook, draft.partNumber);
            if (!offers.length) return null;
            return (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
                <span className="mut t-meta">Price book:</span>
                {offers.map((o, i) => (
                  <button key={`${o.vendor}-${i}`} className="pill" type="button"
                    onClick={() => setDraft({ ...draft, vendor: o.vendor, cost: centsToInput(o.priceCents) })}
                    style={{
                      border: "none", cursor: "pointer",
                      background: draft.vendor === o.vendor ? "var(--navy)" : "#EEF1F5",
                      color: draft.vendor === o.vendor ? "#fff" : "#475569",
                    }}>
                    {o.vendor} {formatCents(o.priceCents)}{o.isOem ? " · OEM" : ""}
                  </button>
                ))}
              </div>
            );
          })()}
          {systemAssets.length > 0 ? (
            <div style={{ marginBottom: 8 }}>
              <label>For asset</label>
              <select value={draft.assetId ?? ""} onChange={(e) => setDraft({ ...draft, assetId: e.target.value ? parseInt(e.target.value) : null })}>
                <option value="">Whole system</option>
                {systemAssets.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
              </select>
            </div>
          ) : target.instrumentId !== null ? (
            <div className="mut t-meta" style={{ marginBottom: 8 }}>
              To tag this part to a specific unit, first list the system&apos;s assets (pump, detector...) in
              the Assets section above - then a &quot;For asset&quot; picker appears here and on each part row.
            </div>
          ) : null}
          {/* A unit on order, not a part: says what it BECOMES, and Received
              will offer the intake instead of ending the story. */}
          <div className="pf2" style={{ marginBottom: 8 }}>
            {showCosts && <div><label>Cost ($)</label><input value={draft.cost} onChange={(e) => setDraft({ ...draft, cost: e.target.value })} placeholder="1,240" /></div>}
            <div>
              <label>Status</label>
              <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
                {PART_STATES.map((s) => <option key={s}>{s}</option>)}
              </select>
              {draft.status === "Removed" && (
                <label className="t-small" style={{ display: "flex", alignItems: "center", gap: 6, margin: "6px 0 0", textTransform: "none", letterSpacing: 0, color: "var(--ink)", fontWeight: 400 }}>
                  <input type="checkbox" checked={draft.requestReplacement} style={{ width: 15, height: 15 }}
                    onChange={(e) => setDraft({ ...draft, requestReplacement: e.target.checked })} />
                  Request new? Files a copy as <b>Needed</b> so the reorder isn&apos;t forgotten.
                </label>
              )}
            </div>
          </div>
          {showOrderFields && (
            <>
              <div className="pf3" style={{ marginBottom: 8 }}>
                {showCosts && <div><label>PO #</label><input value={draft.po} onChange={(e) => setDraft({ ...draft, po: e.target.value })} placeholder="SS-1042" /></div>}
                <div><label>Ordered</label><input value={draft.orderedAt} onChange={(e) => setDraft({ ...draft, orderedAt: e.target.value })} placeholder="Jul 18" /></div>
                <div><label>ETA</label><input value={draft.eta} onChange={(e) => setDraft({ ...draft, eta: e.target.value })} placeholder="Jul 23" /></div>
              </div>
              <div className="pf-ship" style={{ marginBottom: 8 }}>
                <div>
                  <label>Carrier</label>
                  <select value={draft.carrier} onChange={(e) => setDraft({ ...draft, carrier: e.target.value })}>
                    {CARRIERS.map((c) => <option key={c} value={c}>{c || "-"}</option>)}
                  </select>
                </div>
                <div><label>Tracking #</label><input className="mono" value={draft.tracking} onChange={(e) => setDraft({ ...draft, tracking: e.target.value })} placeholder="1Z999AA10123456784" /></div>
              </div>
            </>
          )}
          {/* When the work actually happened, which is often not the day
              somebody got round to recording it. Shown whenever the row is
              finished or heading there, since that is when it means anything. */}
          {showServiceDates && (
            <div className="pf2" style={{ marginBottom: 8 }}>
              <div>
                <label>Installed</label>
                <input type="date" value={draft.installedAt}
                  onChange={(e) => setDraft({ ...draft, installedAt: e.target.value })} />
                {legacy(form?.mode === "edit" ? editing?.installedAt : "", draft.installedAt)}
              </div>
              <div>
                <label>Removed</label>
                <input type="date" value={draft.removedAt}
                  onChange={(e) => setDraft({ ...draft, removedAt: e.target.value })} />
                {legacy(form?.mode === "edit" ? editing?.removedAt : "", draft.removedAt)}
              </div>
            </div>
          )}
          <div style={{ marginBottom: 8 }}>
            {/* Which PM this belongs to. Offered only when the record has any -
                and only to staff, since it is a billing attribution. */}
            {pmJobs.length > 0 && isStaff && (
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
                <label style={{ margin: 0 }}>Part of maintenance</label>
                <select value={draft.pmScheduleId ?? ""} aria-label="Part of maintenance"
                  onChange={(e) => setDraft({ ...draft, pmScheduleId: e.target.value ? parseInt(e.target.value) : null })}
                  className="t-small" style={{ width: "auto", maxWidth: 280 }}>
                  <option value="">Not part of a maintenance job</option>
                  {pmJobs.map((j) => <option key={j.id} value={j.id}>{j.title}</option>)}
                </select>
                {draft.pmScheduleId !== null && (
                  <span className="mut t-meta">
                    stays off the parts allowance where the contract includes PM parts
                  </span>
                )}
              </div>
            )}
            <label>Install / swap note</label>
            <input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              placeholder='e.g. "From stock; replaced failing unit SN 4411, old one returned for RMA"' />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label>Details</label>
            {specPairs.map((p, i) => (
              <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                <input value={p.k} onChange={(e) => setPair(i, { k: e.target.value })} placeholder="Length" className="t-body" style={{ flex: "0 1 120px" }} />
                <input value={p.v} onChange={(e) => setPair(i, { v: e.target.value })} placeholder="30 m" className="t-body" style={{ flex: 1 }} />
                <button className="btn link" style={{ color: "var(--t-bad-fg)", padding: "0 4px" }}
                  onClick={() => setSpecPairs((s) => s.filter((_, idx) => idx !== i))}>×</button>
              </div>
            ))}
            {specPairs.length < SPECS_MAX_PAIRS && (
              <button className="btn link" onClick={() => setSpecPairs((s) => [...s, { k: "", v: "" }])}>
                + add field {specPairs.length === 0 ? "(e.g. ID, Length, Film)" : ""}
              </button>
            )}
          </div>
        </Dialog>
      )}

      {parts.length === 0 && !form && <div className="mut t-body">No parts tracked yet.</div>}
      {(() => {
        const renderRow = (p: Part) => {
          const link = trackUrl(p.carrier, p.tracking);
          const specs = parseSpecs(p.specs);
          // What came in this box. Listed, not repeated as rows: the kit is the
          // thing that was bought and fitted; these are what it contained.
          const inside = p.kind === "kit" ? parts.filter((x) => x.parentPartId === p.id) : [];
          return (
            <div key={p.id} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px", marginBottom: 8, background: "#FAFBFD" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span className="t-body" style={{ fontWeight: 700 }}>{p.name}{p.qty ? <span className="mut" style={{ fontWeight: 400 }}> × {p.qty}</span> : null}</span>
                {canEdit && systemAssets.length > 0 ? (
                  <PartAssetSelect part={p} systemAssets={systemAssets} />
                ) : assetLabel(p.assetId) ? (
                  <span className="pill accent">{assetLabel(p.assetId)}</span>
                ) : null}
                {p.assetId !== null && !assetLabel(p.assetId) && (
                  <span className="pill faint">asset detached</span>
                )}
                {canEdit ? (
                  <PartStatusSelect part={p} />
                ) : (
                  <span className={`pill ${PART_TONE[p.status] ?? "neutral"}`}>{p.status}</span>
                )}
                {/* A unit on order wears what it becomes; once the box is here,
                    the pill turns into the door that puts it on the asset list. */}
                {p.moduleKind && p.assetId === null && (
                  p.status === "Received" && canEdit ? (
                    <button className="btn sm accent" onClick={() => openIntake(p)}>
                      Intake as {p.moduleKind}
                    </button>
                  ) : (
                    <span className="pill info" title="Joins the asset list when it arrives">unit: {p.moduleKind}</span>
                  )
                )}
                {canEdit && <button className="btn link" style={{ marginLeft: "auto" }} onClick={() => openEdit(p)}>edit</button>}
              </div>
              <div className="mut t-small" style={{ marginTop: 5 }}>
                {p.partNumber ? <>PN {p.partNumber}</> : "No PN"}
                {p.serial ? " · SN " + p.serial : ""}
                {p.vendor ? " · " + p.vendor : ""}{p.po ? " · PO " + p.po : ""}{p.cost ? " · $" + p.cost : ""}
              </div>
              {specs.length > 0 && (
                <div className="t-small" style={{ marginTop: 5 }}>
                  {specs.map((s, i) => (
                    <span key={i}>{i > 0 ? " · " : ""}<span className="mut">{s.k}</span> <b style={{ fontWeight: 600 }}>{s.v}</b></span>
                  ))}
                </div>
              )}
              {(p.tracking || p.eta || p.orderedAt || p.receivedAt || p.installedAt || p.removedAt) && (
                <div className="t-small" style={{ marginTop: 5, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                  {p.tracking && (link
                    ? <a className="mono" href={link} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>{p.carrier} {p.tracking} ↗</a>
                    : <span className="mono" style={{ color: "var(--t-info-fg)" }}>{p.carrier ? p.carrier + " " : ""}{p.tracking}</span>)}
                  {p.orderedAt && <span className="mut">Ordered {p.orderedAt}</span>}
                  {p.eta && <span className="mut">ETA {p.eta}</span>}
                  {p.receivedAt && <span style={{ color: "var(--t-good-fg)" }}>Received {dayText(p.receivedAt)}</span>}
                  {p.installedAt && <span style={{ color: "#085041", fontWeight: 700 }}>Installed {dayText(p.installedAt)}</span>}
                  {p.removedAt && <span style={{ color: "#64748B" }}>Pulled {dayText(p.removedAt)}</span>}
                </div>
              )}
              {p.pmScheduleId != null && pmJobs.some((j) => j.id === p.pmScheduleId) && (
                <span className="pill good" style={{ fontSize: 10, marginTop: 4, display: "inline-block" }}>
                  {pmJobs.find((j) => j.id === p.pmScheduleId)!.title}
                </span>
              )}
              {p.note && <div className="t-small" style={{ marginTop: 5, color: "var(--slate, #475569)" }}>{p.note}</div>}
              {inside.length > 0 && (
                <details style={{ marginTop: 6 }}>
                  <summary style={{ cursor: "pointer", fontSize: 12, color: "var(--mut)" }}>
                    contains {inside.length} part{inside.length === 1 ? "" : "s"}
                  </summary>
                  <div style={{ paddingLeft: 12, marginTop: 4 }}>
                    {inside.map((c) => (
                      <div key={c.id} className="t-small" style={{ padding: "2px 0", display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <span>{c.name}{c.qty ? <span className="mut"> × {c.qty}</span> : null}</span>
                        {c.partNumber && <span className="mono mut t-meta">{c.partNumber}</span>}
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          );
        };
        // Parts and consumables read as two lists; within each, what is still
        // coming stays open and what is done folds into the day it happened.
        const section = (rows: Part[]) => {
          const { live, visits } = partGroups(rows, serviceEvents, visitNames);
          return (
            <>
              {live.map(renderRow)}
              {/* The newest visit stays open: those are the parts in the machine
                  right now. Everything before it is history, one line each. */}
              {visits.map((v, i) => (
                <details key={v.day || "undated"} open={i === 0 && v.day !== ""}
                  style={{ borderTop: "1px solid var(--line)" }}>
                  <summary style={{ cursor: "pointer", padding: "7px 2px", fontSize: 13 }}>
                    <b>{v.label}</b>{" "}
                    <span className="mut">
                      · {v.parts.length} {v.parts.length === 1 ? "part" : "parts"}
                      {v.parts.some((r) => r.status === "Removed") && v.parts.every((r) => r.status === "Removed")
                        ? " pulled" : " fitted"}
                    </span>
                    {/* Call the day what it was. A PM day closes seven procedures
                        at once and no list of them says "Annual PM". */}
                    {canEdit && v.day !== "" && (
                      <button className="btn link" style={{ marginLeft: 8 }}
                        onClick={(e) => {
                          // Inside a <summary>: without this the click also
                          // toggles the fold shut under the form that opens.
                          e.preventDefault(); e.stopPropagation();
                          setNaming({ day: v.day, title: visitNames[v.day] ?? "" });
                        }}>{v.named ? "rename" : "name this visit"}</button>
                    )}
                  </summary>
                  {naming?.day === v.day && (
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "0 2px 8px" }}>
                      <input autoFocus value={naming.title} maxLength={80}
                        placeholder="Annual PM"
                        onChange={(e) => setNaming({ day: v.day, title: e.target.value })}
                        onKeyDown={(e) => { if (e.key === "Enter") saveVisitName(); }}
                        className="t-body" style={{ flex: "1 1 180px" }} />
                      <button className="btn sm accent" disabled={pending} onClick={() => saveVisitName()}>Save</button>
                      <button className="btn sm" disabled={pending} onClick={() => setNaming(null)}>Cancel</button>
                      {v.named && (
                        <button className="btn link" style={{ fontSize: 12, color: "var(--t-bad-fg)" }} disabled={pending}
                          onClick={() => { setNaming({ day: v.day, title: "" }); saveVisitName(v.day, ""); }}>
                          clear
                        </button>
                      )}
                    </div>
                  )}
                  {v.parts.map(renderRow)}
                </details>
              ))}
            </>
          );
        };
        // Kit contents are never their own row: they belong under the box they
        // came in, which is how the work actually happened.
        const proper = parts.filter((p) => p.kind !== "consumable" && !p.parentPartId);
        const consumables = parts.filter((p) => p.kind === "consumable" && !p.parentPartId);
        const both = proper.length > 0 && consumables.length > 0;
        return (
          <>
            {both && proper.length > 0 && <div className="eyebrow" style={{ margin: "4px 0 6px" }}>Parts</div>}
            {section(proper)}
            {both && <div className="eyebrow" style={{ margin: "10px 0 6px" }}>Consumables</div>}
            {section(consumables)}
          </>
        );
      })()}
      {(() => {
        if (!showCosts) return null; // server blanks costs too - this just skips an empty row
        // Kit contents are priced at nothing on purpose - the kit carries the
        // money. Counting them here would read "1 of 4 priced" on a kit that
        // is fully priced, which looks like missing data rather than design.
        // Suggestions are not money either: nobody agreed to buy them, and a
        // total that includes them reads as spend that never happened.
        const billable = parts.filter((p) => !p.parentPartId && p.status !== "Suggested");
        const priced = billable.filter((p) => !isNaN(money(p.cost)));
        if (!priced.length) return null;
        const total = priced.reduce((sum, p) => sum + money(p.cost), 0);
        const missing = billable.length - priced.length;
        return (
          <div className="t-small" style={{ display: "flex", justifyContent: "flex-end", gap: 6, marginTop: 2 }}>
            <span className="mut">Parts total{missing > 0 ? ` (${priced.length} of ${billable.length} priced)` : ""}:</span>
            <b>${total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>
          </div>
        );
      })()}
    {intake && (
      <Dialog open onClose={() => setIntake(null)} title={`Intake the new ${intake.moduleKind}`}
        context="It joins this system's asset list, In service"
        footer={
          <>
            <DialogStatus error={intakeErr}
              problem={!intakeDraft.model.trim() && !intakeDraft.serial.trim() ? "give it a model or a serial" : null}
              ok="The part line closes as Installed and points at the unit." />
            <button className="btn" onClick={() => setIntake(null)} disabled={pending}>Cancel</button>
            <button className="btn accent" disabled={pending || (!intakeDraft.model.trim() && !intakeDraft.serial.trim())}
              onClick={() => startTransition(async () => {
                const res = await intakeModule(intake.partId, {
                  kind: intakeDraft.kind, manufacturer: intakeDraft.manufacturer,
                  model: intakeDraft.model, serial: intakeDraft.serial,
                  owner: "", location: intakeDraft.location, note: "",
                  replacesAssetId: intakeDraft.replacesAssetId ? parseInt(intakeDraft.replacesAssetId, 10) : null,
                });
                if (res?.error) { setIntakeErr(res.error); return; }
                toast({ message: `On the asset list - new ${intakeDraft.kind || intake.moduleKind}` });
                setIntake(null);
              })}>
              {pending ? "Intaking..." : "Put it on the asset list"}
            </button>
          </>
        }>
        <div className="pf2" style={{ marginBottom: 8 }}>
          <div>
            <label>Kind</label>
            <select value={intakeDraft.kind} onChange={(e) => setIntakeDraft({ ...intakeDraft, kind: e.target.value })}>
              {moduleTypeOptions(moduleTypes, intakeDraft.kind).map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
          <div>
            <label>Serial - from the box</label>
            <input value={intakeDraft.serial} autoFocus placeholder="US2411223"
              onChange={(e) => setIntakeDraft({ ...intakeDraft, serial: e.target.value })} />
          </div>
        </div>
        <div className="pf2" style={{ marginBottom: 8 }}>
          <div>
            <label>Manufacturer</label>
            <input value={intakeDraft.manufacturer}
              onChange={(e) => setIntakeDraft({ ...intakeDraft, manufacturer: e.target.value })} />
          </div>
          <div>
            <label>Model</label>
            <input value={intakeDraft.model}
              onChange={(e) => setIntakeDraft({ ...intakeDraft, model: e.target.value })} />
          </div>
        </div>
        {systemAssets.length > 0 && (
          <div style={{ marginBottom: 8 }}>
            <label>Replaces</label>
            {/* The reason anybody ordered one. Picking here decommissions the
                old unit in the same act, with events on both sides. */}
            <select value={intakeDraft.replacesAssetId}
              onChange={(e) => setIntakeDraft({ ...intakeDraft, replacesAssetId: e.target.value })}>
              <option value="">Nothing - an addition</option>
              {systemAssets.map((a) => <option key={a.id} value={a.id}>{a.label} - decommission it</option>)}
            </select>
          </div>
        )}
      </Dialog>
    )}
    </div>
  );
}
