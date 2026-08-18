"use client";

import { promptReason } from "@/lib/reason";
import { useOptimistic, useState, useTransition } from "react";
import { CARRIERS, PART_STATES, PART_COLOR, ORDER_STATES, trackUrl } from "@/lib/stages";
import { parseSpecs, serializeSpecs, SPECS_MAX_PAIRS, type SpecPair } from "@/lib/partSpecs";
import {
  createPart, updatePart, setPartStatus, setPartAsset, deletePart, nameServiceVisit, type WorkTarget,
} from "@/app/actions";
import { pricesFor, type PriceEntry } from "@/lib/priceBook";
import PartNumberField from "./PartNumberField";
import { formatCents, centsToInput } from "@/lib/money";
import { dayText, isoDay, partGroups, type ServiceEvent } from "@/lib/partGroups";

type Part = {
  id: number; kind: string; assetId: number | null; name: string; partNumber: string; serial: string; qty: string; specs: string;
  vendor: string; po: string; cost: string;
  carrier: string; tracking: string; orderedAt: string; eta: string; receivedAt: string;
  installedAt: string; removedAt: string; note: string; status: string; createdAt: string;
};

function PartStatusSelect({ part }: { part: Part }) {
  const [, startTransition] = useTransition();
  const [status, setOptimistic] = useOptimistic(part.status, (_cur: string, next: string) => next);
  return (
    <select
      value={status}
      onChange={(e) => startTransition(async () => { setOptimistic(e.target.value); await setPartStatus(part.id, e.target.value); })}
      style={{ width: "auto", fontSize: 11, fontWeight: 700, padding: "3px 6px", borderRadius: 999, background: PART_COLOR[status]?.bg, color: PART_COLOR[status]?.fg, cursor: "pointer" }}
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
      style={{ width: "auto", fontSize: 11, fontWeight: 700, padding: "3px 6px", borderRadius: 999, background: assetId !== null ? "#EDEBFA" : "#EEF1F5", color: assetId !== null ? "#4F45A3" : "#475569", cursor: "pointer" }}
    >
      <option value="">Whole system</option>
      {systemAssets.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
    </select>
  );
}

const empty = { kind: "part", assetId: null as number | null, name: "", partNumber: "", serial: "", qty: "", vendor: "", po: "", cost: "", carrier: "", tracking: "", orderedAt: "", eta: "", status: "Needed", note: "", installedAt: "", removedAt: "", requestReplacement: false };

const money = (s: string) => parseFloat(s.replace(/[^0-9.]/g, ""));

export default function PartsPanel({ target, parts, systemAssets, canEdit, isStaff, showCosts, priceBook = [], serviceEvents = [], visitNames = {} }: {
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
}) {
  const assetLabel = (id: number | null) => systemAssets.find((a) => a.id === id)?.label ?? null;
  const [form, setForm] = useState<null | { mode: "new" } | { mode: "edit"; id: number }>(null);
  const [draft, setDraft] = useState<typeof empty>(empty);
  const [specPairs, setSpecPairs] = useState<SpecPair[]>([]);
  const [pending, startTransition] = useTransition();

  // Which day's heading is being renamed, and to what.
  const [naming, setNaming] = useState<null | { day: string; title: string }>(null);

  const openNew = () => { setDraft(empty); setSpecPairs([]); setForm({ mode: "new" }); };
  const openEdit = (p: Part) => {
    // A date input only accepts a calendar day, so a row still carrying one of
    // the old year-less strings opens blank and says what is stored underneath.
    setDraft({ kind: p.kind, assetId: p.assetId, name: p.name, partNumber: p.partNumber, serial: p.serial, qty: p.qty, vendor: p.vendor, po: p.po, cost: p.cost, carrier: p.carrier, tracking: p.tracking, orderedAt: p.orderedAt, eta: p.eta, status: p.status, note: p.note, installedAt: isoDay(p.installedAt), removedAt: isoDay(p.removedAt), requestReplacement: false });
    setSpecPairs(parseSpecs(p.specs));
    setForm({ mode: "edit", id: p.id });
  };
  const close = () => { setForm(null); setDraft(empty); setSpecPairs([]); };

  // Consumables usually come off the shelf and go straight in; parts start as Needed.
  const setKind = (kind: string) => {
    setDraft((d) => ({ ...d, kind, ...(form?.mode === "new" ? { status: kind === "consumable" ? "Installed" : "Needed" } : {}) }));
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
      ? <div className="mut" style={{ fontSize: 11, marginTop: 3 }}>recorded as &ldquo;{stored}&rdquo;</div>
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
    });
  };

  const save = () => {
    if (!draft.name.trim() || !form) return;
    const payload = { ...draft, specs: serializeSpecs(specPairs) };
    startTransition(async () => {
      if (form.mode === "new") await createPart(target, payload);
      else await updatePart(form.id, payload);
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

      {form && (
        <div className="dash-form">
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: "var(--navy)" }}>
              {form.mode === "new" ? "New" : "Edit"}
            </div>
            <div style={{ display: "flex", gap: 4 }}>
              {[["part", "Part"], ["consumable", "Consumable"]].map(([k, label]) => (
                <button key={k} className="pill" onClick={() => setKind(k)}
                  style={{
                    border: "none", cursor: "pointer",
                    background: draft.kind === k ? "var(--navy)" : "#EEF1F5",
                    color: draft.kind === k ? "#fff" : "#475569",
                  }}>{label}</button>
              ))}
            </div>
            {draft.kind === "consumable" && (
              <span className="mut" style={{ fontSize: 11 }}>ferrules, septa, liners... defaults to Installed</span>
            )}
          </div>
          <div className="pf2" style={{ marginBottom: 8 }}>
            <div style={{ gridColumn: "1 / -1" }}>
              <label>Name *</label>
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder={draft.kind === "consumable" ? "e.g. Vespel ferrule 1/4in" : "e.g. 10kV HED supply"} />
            </div>
            <div>
              <label>Part number</label>
              {/* Resolves against the parts book first: the name comes with it,
                  so a described part is never re-described by hand. */}
              <PartNumberField value={draft.partNumber} placeholder="G6303-80060" className=""
                onChange={(partNumber) => setDraft({ ...draft, partNumber })}
                onPick={(part) => setDraft((d) => ({
                  ...d,
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
                <span className="mut" style={{ fontSize: 11 }}>Price book:</span>
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
            <div className="mut" style={{ fontSize: 11, marginBottom: 8 }}>
              To tag this part to a specific unit, first list the system&apos;s assets (pump, detector...) in
              the Assets section above - then a &quot;For asset&quot; picker appears here and on each part row.
            </div>
          ) : null}
          <div className="pf2" style={{ marginBottom: 8 }}>
            {showCosts && <div><label>Cost ($)</label><input value={draft.cost} onChange={(e) => setDraft({ ...draft, cost: e.target.value })} placeholder="1,240" /></div>}
            <div>
              <label>Status</label>
              <select value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value })}>
                {PART_STATES.map((s) => <option key={s}>{s}</option>)}
              </select>
              {draft.status === "Removed" && (
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, margin: "6px 0 0", textTransform: "none", letterSpacing: 0, color: "var(--ink)", fontWeight: 400 }}>
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
            <label>Install / swap note</label>
            <input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              placeholder='e.g. "From stock; replaced failing unit SN 4411, old one returned for RMA"' />
          </div>
          <div style={{ marginBottom: 12 }}>
            <label>Details</label>
            {specPairs.map((p, i) => (
              <div key={i} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                <input value={p.k} onChange={(e) => setPair(i, { k: e.target.value })} placeholder="Length" style={{ flex: "0 1 120px", fontSize: 13 }} />
                <input value={p.v} onChange={(e) => setPair(i, { v: e.target.value })} placeholder="30 m" style={{ flex: 1, fontSize: 13 }} />
                <button className="btn link" style={{ color: "#A32D2D", padding: "0 4px" }}
                  onClick={() => setSpecPairs((s) => s.filter((_, idx) => idx !== i))}>×</button>
              </div>
            ))}
            {specPairs.length < SPECS_MAX_PAIRS && (
              <button className="btn link" onClick={() => setSpecPairs((s) => [...s, { k: "", v: "" }])}>
                + add field {specPairs.length === 0 ? "(e.g. ID, Length, Film)" : ""}
              </button>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button className="btn sm accent" onClick={save} disabled={pending}>
              {pending ? "Saving..." : form.mode === "new" ? "Add part" : "Save changes"}
            </button>
            <button className="btn sm" onClick={close}>Cancel</button>
            {form.mode === "edit" && isStaff && (
              <button
                className="btn link" style={{ marginLeft: "auto", color: "#A32D2D", fontSize: 12, fontWeight: 700 }}
                onClick={() => {
                  const reason = promptReason(`Delete part record "${draft.name}"? This removes it from the record entirely.`);
                  if (!reason) return;
                  startTransition(async () => { await deletePart((form as { id: number }).id, reason); close(); });
                }}
              >Remove</button>
            )}
          </div>
        </div>
      )}

      {parts.length === 0 && !form && <div className="mut" style={{ fontSize: 13 }}>No parts tracked for this system.</div>}
      {(() => {
        const renderRow = (p: Part) => {
          const link = trackUrl(p.carrier, p.tracking);
          const specs = parseSpecs(p.specs);
          return (
            <div key={p.id} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px", marginBottom: 8, background: "#FAFBFD" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={{ fontWeight: 700, fontSize: 13 }}>{p.name}{p.qty ? <span className="mut" style={{ fontWeight: 400 }}> × {p.qty}</span> : null}</span>
                {canEdit && systemAssets.length > 0 ? (
                  <PartAssetSelect part={p} systemAssets={systemAssets} />
                ) : assetLabel(p.assetId) ? (
                  <span className="pill" style={{ background: "#EDEBFA", color: "#4F45A3" }}>{assetLabel(p.assetId)}</span>
                ) : null}
                {p.assetId !== null && !assetLabel(p.assetId) && (
                  <span className="pill" style={{ background: "#EEF1F5", color: "#94A3B8" }}>asset detached</span>
                )}
                {canEdit ? (
                  <PartStatusSelect part={p} />
                ) : (
                  <span className="pill" style={{ background: PART_COLOR[p.status]?.bg, color: PART_COLOR[p.status]?.fg }}>{p.status}</span>
                )}
                {canEdit && <button className="btn link" style={{ marginLeft: "auto" }} onClick={() => openEdit(p)}>edit</button>}
              </div>
              <div className="mut" style={{ fontSize: 12, marginTop: 5 }}>
                {p.partNumber ? <>PN {p.partNumber}</> : "No PN"}
                {p.serial ? " · SN " + p.serial : ""}
                {p.vendor ? " · " + p.vendor : ""}{p.po ? " · PO " + p.po : ""}{p.cost ? " · $" + p.cost : ""}
              </div>
              {specs.length > 0 && (
                <div style={{ fontSize: 12, marginTop: 5 }}>
                  {specs.map((s, i) => (
                    <span key={i}>{i > 0 ? " · " : ""}<span className="mut">{s.k}</span> <b style={{ fontWeight: 600 }}>{s.v}</b></span>
                  ))}
                </div>
              )}
              {(p.tracking || p.eta || p.orderedAt || p.receivedAt || p.installedAt || p.removedAt) && (
                <div style={{ fontSize: 12, marginTop: 5, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                  {p.tracking && (link
                    ? <a className="mono" href={link} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>{p.carrier} {p.tracking} ↗</a>
                    : <span className="mono" style={{ color: "#1D6396" }}>{p.carrier ? p.carrier + " " : ""}{p.tracking}</span>)}
                  {p.orderedAt && <span className="mut">Ordered {p.orderedAt}</span>}
                  {p.eta && <span className="mut">ETA {p.eta}</span>}
                  {p.receivedAt && <span style={{ color: "#2E6B2E" }}>Received {dayText(p.receivedAt)}</span>}
                  {p.installedAt && <span style={{ color: "#085041", fontWeight: 700 }}>Installed {dayText(p.installedAt)}</span>}
                  {p.removedAt && <span style={{ color: "#64748B" }}>Pulled {dayText(p.removedAt)}</span>}
                </div>
              )}
              {p.note && <div style={{ fontSize: 12, marginTop: 5, color: "var(--slate, #475569)" }}>{p.note}</div>}
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
                  <summary style={{ cursor: "pointer", padding: "7px 2px", fontSize: 12.5 }}>
                    <b>{v.label}</b>{" "}
                    <span className="mut">
                      · {v.parts.length} {v.parts.length === 1 ? "part" : "parts"}
                      {v.parts.some((r) => r.status === "Removed") && v.parts.every((r) => r.status === "Removed")
                        ? " pulled" : " fitted"}
                    </span>
                    {/* Call the day what it was. A PM day closes seven procedures
                        at once and no list of them says "Annual PM". */}
                    {canEdit && v.day !== "" && (
                      <button className="btn link" style={{ fontSize: 11, marginLeft: 8 }}
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
                        style={{ flex: "1 1 180px", fontSize: 13 }} />
                      <button className="btn sm accent" disabled={pending} onClick={() => saveVisitName()}>Save</button>
                      <button className="btn sm" disabled={pending} onClick={() => setNaming(null)}>Cancel</button>
                      {v.named && (
                        <button className="btn link" style={{ fontSize: 12, color: "#A32D2D" }} disabled={pending}
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
        const proper = parts.filter((p) => p.kind !== "consumable");
        const consumables = parts.filter((p) => p.kind === "consumable");
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
        const priced = parts.filter((p) => !isNaN(money(p.cost)));
        if (!priced.length) return null;
        const total = priced.reduce((sum, p) => sum + money(p.cost), 0);
        return (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, fontSize: 12, marginTop: 2 }}>
            <span className="mut">Parts total{priced.length < parts.length ? ` (${priced.length} of ${parts.length} priced)` : ""}:</span>
            <b>${total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</b>
          </div>
        );
      })()}
    </div>
  );
}
