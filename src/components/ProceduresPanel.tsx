"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { addProcedure, updateProcedure, deleteProcedure, reorderProcedures,
  copyProcedureToTypes, moveTypeToCategory,
} from "@/app/actions";
import { summarizeItem, RESULT_TYPES, RESULT_LABEL } from "@/lib/checkout";
import { cadenceLabel } from "@/lib/pm";
import { describeProcedure, type ProcPart } from "@/lib/procedures";
import { parseChecklist } from "@/lib/checklist";
import PartNumberField from "./PartNumberField";
import { procedureRole, ROLE_COLOR, ROLE_LABEL } from "@/lib/procedureRole";
import { QUALIFICATIONS, QUAL_LABEL } from "@/lib/gxp";
import ProvenanceChip from "./ProvenanceChip";
import { PROVENANCE_BLURB, PROVENANCE_CHOICES, PROVENANCE_LABEL, tallyLine, tallyProvenance } from "@/lib/provenance";

export type ProcedureRow = {
  id: number; assetType: string; kind: string; name: string; notes: string; position: number;
  resultType: string; target: string | null; tolerancePct: string | null;
  requiresNote: boolean; consumesPart: boolean;
  runsAtIntake: boolean; intervalDays: number | null; required: boolean;
  qualification: string;
  parts: ProcPart[]; modelScope: string[]; categoryScope: string[];
  checklist: string;
  /** '' | original | facts | oem - see lib/provenance. */
  provenance?: string;
};

const KIND_GLYPH: Record<string, { glyph: string; bg: string; fg: string }> = {
  task: { glyph: "☐", bg: "#E7F2FA", fg: "#1D6396" },
  test: { glyph: "◎", bg: "#EDEBFA", fg: "#4F45A3" },
};

const CADENCES = [
  { days: "7", label: "weekly" }, { days: "14", label: "every 2 weeks" },
  { days: "30", label: "monthly" }, { days: "90", label: "quarterly" },
  { days: "180", label: "every 6 months" }, { days: "365", label: "yearly" },
];

const FILTERS = [
  { key: "all", label: "All" },
  { key: "intake", label: "At intake" },
  { key: "recurring", label: "Maintenance" },
  { key: "tests", label: "Tests" },
  { key: "tasks", label: "Tasks" },
] as const;
type FilterKey = typeof FILTERS[number]["key"];

const passesFilter = (p: ProcedureRow, f: FilterKey) =>
  f === "all" ? true
    : f === "intake" ? p.runsAtIntake
    : f === "recurring" ? p.intervalDays !== null
    : f === "tests" ? p.kind === "test"
    : p.kind === "task";

// The sheet's draft. `repeats` and `intervalDays` are separate so switching
// Repeats off remembers the cadence for when it comes back on.
type Draft = {
  kind: string; name: string; notes: string;
  resultType: string; target: string; tolerancePct: string;
  requiresNote: boolean; consumesPart: boolean;
  runsAtIntake: boolean; repeats: boolean; intervalDays: string; required: boolean;
  qualification: string;
  parts: ProcPart[]; modelScope: string[]; categoryScope: string[];
  checklist: string;
  provenance: string;
};
const emptyDraft: Draft = {
  kind: "task", name: "", notes: "",
  resultType: "pass_fail", target: "", tolerancePct: "",
  requiresNote: false, consumesPart: false,
  // Filters never pre-fill this: a new procedure always starts with both off.
  // Yearly, because most upkeep worth writing down is annual and picking the
  // same value on every new procedure is a tax on the common case.
  runsAtIntake: false, repeats: false, intervalDays: "365", required: false,
  qualification: "",
  parts: [], modelScope: [], categoryScope: [], checklist: "", provenance: "",
};

/** Multiselect over catalog models: chips in the field, type-to-filter list below. */
function ScopeField({ scope, options, onChange }: {
  scope: string[]; options: string[]; onChange: (next: string[]) => void;
}) {
  const [filter, setFilter] = useState("");
  const available = options.filter(
    (o) => !scope.some((s) => s.toLowerCase() === o.toLowerCase())
      && o.toLowerCase().includes(filter.trim().toLowerCase())
  );
  return (
    <div>
      <div style={{ border: "1px solid var(--line)", borderRadius: 8, background: "#fff", padding: 6, display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
        {scope.length === 0 && <span className="pill" style={{ background: "#EEF1F5", color: "#94A3B8" }}>All models</span>}
        {scope.map((m) => (
          <span key={m} className="pill" style={{ background: "#EDEBFA", color: "#4F45A3", display: "inline-flex", alignItems: "center", gap: 4 }}>
            {m}
            <button type="button" className="chip-x" aria-label={`Remove ${m}`}
              onClick={() => onChange(scope.filter((s) => s !== m))}
              style={{ border: "none", background: "none", color: "inherit", cursor: "pointer", padding: 0, fontSize: 12, lineHeight: 1 }}>×</button>
          </span>
        ))}
        <input value={filter} onChange={(e) => setFilter(e.target.value)}
          placeholder={options.length ? "Type to filter models..." : "No models in the catalog yet - define them in Settings → Catalog"}
          style={{ border: "none", flex: "1 1 120px", minWidth: 100, padding: "3px 4px", fontSize: 12 }} />
      </div>
      {available.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 6, maxHeight: 96, overflowY: "auto" }}>
          {available.map((o) => (
            <button key={o} type="button" className="pill" onClick={() => { onChange([...scope, o]); setFilter(""); }}
              style={{ border: "1px solid var(--line)", background: "#fff", color: "var(--slate)", cursor: "pointer" }}>
              + {o}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The one procedure catalog: what gets done to equipment, per module type. A
 * row's badges say everything - kind, when it fires, scope, parts - and every
 * badge maps to a control in the one sheet that both adds and edits.
 */
export default function ProceduresPanel({ items, assetTypes, modelOptions, categories, categoriesByType }: {
  items: ProcedureRow[];
  assetTypes: string[]; // from Settings > Catalog
  modelOptions: Record<string, string[]>;
  categories: string[];                            // system categories, from the catalog
  categoriesByType: Record<string, string[]>;      // which categories each module type serves
}) {
  const [openBand, setOpenBand] = useState<string | null>("system");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [sheet, setSheet] = useState<null | { assetType: string; id?: number }>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  // Snapshot of the timing at sheet-open, to detect a change worth warning about.
  const [timingBefore, setTimingBefore] = useState<{ intervalDays: number | null } | null>(null);
  const [applyNow, setApplyNow] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [flashId, setFlashId] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();
  const [orderOverride, setOrderOverride] = useState<Record<string, number[]>>({});
  // Which procedure is being copied to another module type, and which type is
  // being re-filed under a different system category. One at a time each: both
  // are corrections somebody makes deliberately, not bulk work.
  const [copying, setCopying] = useState<ProcedureRow | null>(null);
  const [copyTo, setCopyTo] = useState<string[]>([]);
  const [moving, setMoving] = useState<{ assetType: string; from: string } | null>(null);
  const [moveTo, setMoveTo] = useState("");
  // A shared procedure being removed FROM ONE system type's view. Deleting the
  // row would take it off every system type it serves - which is how "I deleted
  // the TOC copy and the LC-MS one vanished too" happened - so removal inside a
  // band offers to narrow the scope instead.
  const [removing, setRemoving] = useState<{ row: ProcedureRow; band: string; served: string[] } | null>(null);
  const listRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const rowRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const drag = useRef<{ listKey: string; assetType: string; ids: number[]; itemId: number; dirty: boolean } | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  // System first - instrument-level procedures run once per system. Types with
  // rows but no catalog entry still render, so nothing predating the catalog
  // goes invisible. Order is the catalog's; it never reshuffles by content.
  const GROUPS: { type: string; label: string; subtitle?: string }[] = [
    { type: "system", label: "System", subtitle: "The whole instrument, not a unit inside it - at intake, on a schedule, or both." },
    ...[...new Set([...assetTypes, ...items.map((i) => i.assetType)])]
      .filter((t) => t && t !== "system")
      .map((k) => ({ type: k, label: k })),
  ];

  // The Catalog tab's own shape: category, then module type. A type that serves
  // more than one category appears under each, exactly as a model does there -
  // it is the same underlying list either way, so an edit or a reorder in one
  // place is an edit in both.
  const BANDS = useMemo(() => {
    const typesOf = (cat: string) =>
      GROUPS.filter((g) => g.type !== "system" && (categoriesByType[g.type] ?? []).includes(cat))
        .map((g) => g.type);
    const spoken = new Set(categories.flatMap(typesOf));
    const orphans = GROUPS.filter((g) => g.type !== "system" && !spoken.has(g.type)).map((g) => g.type);
    return [
      { key: "system", label: "System", types: ["system"], subtitle: "The whole instrument, not a unit inside it - at intake, on a schedule, or both." },
      ...categories.map((c) => ({ key: c, label: c, types: typesOf(c), subtitle: "" }))
        .filter((b) => b.types.length),
      ...(orphans.length
        ? [{ key: "__loose", label: "Not tied to a category", types: orphans, subtitle: "Module types no catalog model places yet." }]
        : []),
    ];
  // GROUPS is derived from the same inputs, so recomputing on those is enough.
  }, [categories, categoriesByType, assetTypes, items]);

  const grouped = useMemo(() => {
    const by = new Map<string, ProcedureRow[]>();
    for (const g of GROUPS) by.set(g.type, []);
    for (const i of items) by.get(i.assetType)?.push(i);
    for (const [, list] of by) list.sort((a, b) => a.position - b.position || a.id - b.id);
    return by;
    // GROUPS is derived from these:
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, assetTypes]);

  // A type's rows, seen from one band: a module procedure scoped to system
  // types appears only under those; unscoped ones appear under every band the
  // type serves. This is what makes TOC's autosampler list and LC-MS's two
  // different lists instead of one list drawn twice.
  const rowsIn = (bandKey: string, type: string): ProcedureRow[] => {
    const all = grouped.get(type) ?? [];
    if (bandKey === "system" || bandKey === "__loose" || type === "system") return all;
    return all.filter((p) => p.categoryScope.length === 0
      || p.categoryScope.some((c) => c.toLowerCase() === bandKey.toLowerCase()));
  };
  // The in-flight drag order for one band's view of a type.
  const applyOrder = (listKey: string, list: ProcedureRow[]): ProcedureRow[] => {
    const order = orderOverride[listKey];
    if (!order) return list;
    const at = (id: number) => { const i = order.indexOf(id); return i === -1 ? Number.MAX_SAFE_INTEGER : i; };
    return [...list].sort((a, b) => at(a.id) - at(b.id));
  };

  // Sheet lifecycle: escape closes, focus moves in and stays trapped.
  useEffect(() => {
    if (!sheet) return;
    const el = sheetRef.current;
    el?.querySelector<HTMLElement>("input, button, select")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setSheet(null); return; }
      if (e.key !== "Tab" || !el) return;
      const focusables = [...el.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]")].filter((f) => !f.hasAttribute("disabled"));
      if (!focusables.length) return;
      const first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sheet]);

  // Brief highlight on the row that just changed, and keep it in view.
  useEffect(() => {
    if (flashId === null) return;
    rowRefs.current[flashId]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    const t = setTimeout(() => setFlashId(null), 1600);
    return () => clearTimeout(t);
  }, [flashId]);

  const openAdd = (assetType: string, bandKey?: string) => {
    // Filters never pre-fill the sheet - but the band does: adding from inside
    // TOC means a TOC procedure when the type serves more than one system
    // type. Without this, adding under LC-MS also added it to TOC.
    const served = categoriesByType[assetType] ?? [];
    const scoped = bandKey && bandKey !== "system" && bandKey !== "__loose" && served.length > 1;
    setDraft({ ...emptyDraft, categoryScope: scoped ? [bandKey] : [] });
    setTimingBefore(null);
    setApplyNow(false);
    setError("");
    setSheet({ assetType });
  };
  const draftFrom = (i: ProcedureRow): Draft => ({
    kind: i.kind, name: i.name, notes: i.notes,
    resultType: i.resultType, target: i.target ?? "", tolerancePct: i.tolerancePct ?? "",
    requiresNote: i.requiresNote, consumesPart: i.consumesPart,
    runsAtIntake: i.runsAtIntake, repeats: i.intervalDays !== null,
    intervalDays: String(i.intervalDays ?? 365), required: i.required,
    qualification: i.qualification,
    parts: i.parts.map((p) => ({ ...p })), modelScope: i.modelScope,
    categoryScope: i.categoryScope, checklist: i.checklist,
    provenance: i.provenance ?? "",
  });
  const openEdit = (i: ProcedureRow) => {
    setDraft(draftFrom(i));
    setTimingBefore({ intervalDays: i.intervalDays });
    setApplyNow(false);
    setError("");
    setSheet({ assetType: i.assetType, id: i.id });
  };
  // A new procedure pre-filled from an existing one, on the same type. This is
  // how "the LC-30 takes different work than the LC-20" gets its own row:
  // duplicate, narrow the model scope, change what differs. The system-type
  // scope carries over - a TOC variant belongs to TOC until said otherwise.
  const openDuplicate = (i: ProcedureRow) => {
    setDraft({ ...draftFrom(i), modelScope: [] });
    setTimingBefore(null);
    setApplyNow(false);
    setError("");
    setSheet({ assetType: i.assetType });
  };

  const isSystem = sheet?.assetType === "system";
  const effectiveInterval = draft.repeats ? parseInt(draft.intervalDays) || null : null;
  const timingValid = draft.runsAtIntake || effectiveInterval !== null;

  // Which timing change is in flight, for the edit-time notice. Only shown
  // when editing and only when the timing actually changed.
  const timingChange = sheet?.id && timingBefore
    ? timingBefore.intervalDays === null && effectiveInterval !== null ? "added"
      : timingBefore.intervalDays !== null && effectiveInterval === null ? "removed"
      : timingBefore.intervalDays !== null && effectiveInterval !== null && timingBefore.intervalDays !== effectiveInterval ? "changed"
      : null
    : null;

  const save = () => {
    if (!sheet || !draft.name.trim()) return;
    if (!timingValid) { setError("Pick when it runs: at intake, on a cadence, or both"); return; }
    setError("");
    const payload = {
      assetType: sheet.assetType, kind: draft.kind, name: draft.name, notes: draft.notes,
      resultType: draft.resultType, target: draft.target, tolerancePct: draft.tolerancePct,
      requiresNote: draft.requiresNote, consumesPart: draft.consumesPart,
      runsAtIntake: draft.runsAtIntake, required: draft.required,
      qualification: draft.qualification,
      intervalDays: draft.repeats ? draft.intervalDays : null,
      parts: draft.parts, modelScope: isSystem ? [] : draft.modelScope,
      categoryScope: draft.categoryScope, checklist: draft.checklist,
      provenance: draft.provenance,
    };
    startTransition(async () => {
      const res = sheet.id
        ? await updateProcedure(sheet.id, payload, timingChange !== null && applyNow)
        : await addProcedure(payload);
      if (res?.error) { setError(res.error); return; }
      setSheet(null);
      if (sheet.id) setFlashId(sheet.id);
      const extra = res && "applied" in res && res.applied ? ` - scheduled on ${res.applied} existing unit${res.applied === 1 ? "" : "s"}`
        : res && "retimed" in res && res.retimed ? ` - re-timed ${res.retimed} existing schedule${res.retimed === 1 ? "" : "s"}`
        : res && "unscheduled" in res && res.unscheduled ? ` - unscheduled from ${res.unscheduled} unit${res.unscheduled === 1 ? "" : "s"}`
        : "";
      setSaved(`Saved "${draft.name.trim()}"${extra}`);
      setTimeout(() => setSaved(""), 4000);
    });
  };

  // Pointer-based reorder (mouse and touch; the handle has touch-action: none
  // so dragging doesn't scroll). Only offered on the unfiltered list - a drag
  // between visible rows with hidden ones between them would lie about order.
  const startDrag = (e: React.PointerEvent, listKey: string, assetType: string, ids: number[], itemId: number) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { listKey, assetType, ids, itemId, dirty: false };
  };
  const moveDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    const wrap = d && listRefs.current[d.listKey];
    if (!d || !wrap) return;
    const rows = [...wrap.children] as HTMLElement[];
    let to = rows.length;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { to = i; break; }
    }
    const from = d.ids.indexOf(d.itemId);
    if (to > from) to--;
    if (to === from) return;
    const ids = [...d.ids];
    ids.splice(from, 1);
    ids.splice(to, 0, d.itemId);
    d.ids = ids;
    d.dirty = true;
    setOrderOverride((s) => ({ ...s, [d.listKey]: ids }));
  };
  const endDrag = () => {
    const d = drag.current;
    drag.current = null;
    // The server re-positions the ids it is given and leaves the rest alone,
    // so reordering one band's view of a type is safe.
    if (d?.dirty) startTransition(() => reorderProcedures(d.assetType, d.ids));
  };

  const sentence = describeProcedure({
    assetType: sheet?.assetType ?? "", runsAtIntake: draft.runsAtIntake,
    intervalDays: effectiveInterval, modelScope: isSystem ? [] : draft.modelScope,
    categoryScope: draft.categoryScope,
    parts: draft.parts.filter((p) => p.name.trim() || p.number.trim()),
  });

  const renderRow = (i: ProcedureRow, assetType: string, bandKey: string, listKey: string, listIds: number[]) => {
    const k = KIND_GLYPH[i.kind] ?? KIND_GLYPH.test;
    // A system procedure is narrowed by category, everything else by model.
    const scopeChips = assetType === "system" ? i.categoryScope : i.modelScope;
    const served = categoriesByType[assetType] ?? [];
    // Which system types this row effectively belongs to - explicit scope, or
    // everything the type serves.
    const effective = i.categoryScope.length ? i.categoryScope : served;
    const shared = assetType !== "system" && served.length > 1;
    const role = procedureRole(i);
    return (
      <div key={i.id} ref={(el) => { rowRefs.current[i.id] = el; }}
        style={{
          display: "flex", alignItems: "center", gap: 8, padding: "7px 8px",
          border: "1px solid var(--line)", borderRadius: 8, marginBottom: 6,
          background: flashId === i.id ? "#FDF8EE" : scopeChips.length ? "#FBFAFE" : "#fff",
          transition: "background 600ms",
          boxShadow: scopeChips.length ? "inset 3px 0 0 #6B4FA0" : "none",
        }}>
        {filter === "all" && (
          <span className="drag-handle mut" aria-label="Drag to reorder" tabIndex={0}
            onPointerDown={(e) => startDrag(e, listKey, assetType, listIds, i.id)} onPointerMove={moveDrag}
            onPointerUp={endDrag} onPointerCancel={endDrag}
            style={{ fontSize: 13, userSelect: "none", padding: "2px 2px" }}>⠿</span>
        )}
        <span aria-hidden style={{ width: 20, height: 20, borderRadius: 5, background: k.bg, color: k.fg, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 12, flexShrink: 0 }}>
          {k.glyph}
        </span>
        <button onClick={() => openEdit(i)} disabled={pending}
          style={{ flex: 1, minWidth: 0, textAlign: "left", border: "none", background: "none", padding: 0, cursor: "pointer" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)" }}>{i.name}</div>
          {i.notes && (
            <div className="mut" style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.notes}</div>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 2, alignItems: "center" }}>
            {/* Tests always summarize; a task only when it has something to
                say (an outcome, a required note) - "Done / not done" is noise. */}
            {(i.kind === "test" || summarizeItem({ ...i }) !== "Done / not done") && (
              <span className="mono" style={{ fontSize: 11, color: "var(--slate)", background: "#F1F4F8", borderRadius: 4, padding: "1px 5px" }}>
                {summarizeItem({ ...i })}
              </span>
            )}
            {i.required && (
              <span className="pill" style={{ background: "#FBE9E9", color: "#A32D2D" }}
                title="Must be done before sign-off; a test also needs a report on file">Required</span>
            )}
            {i.qualification && (
              <span className="pill" style={{ background: "#E9E4F5", color: "#5B3E96" }}
                title={`${QUAL_LABEL[i.qualification] ?? i.qualification} work on regulated (GxP) systems`}>
                {i.qualification}
              </span>
            )}
            {/* Display-only here: the whole row is already a button that opens
                the sheet, and a button inside a button is both invalid markup
                and a click that fires twice. The sheet carries the picker. */}
            <ProvenanceChip what="procedure" id={i.id} value={i.provenance ?? ""} canEdit={false} />
            {/* What it IS, in the word the shop uses, before the detail of when.
                The row used to make the reader assemble "this is a PM" from a
                cadence pill. See lib/procedureRole. */}
            <span className="pill" style={{ background: ROLE_COLOR[role].bg, color: ROLE_COLOR[role].fg, fontWeight: 700 }}>{ROLE_LABEL[role]}</span>
            {i.intervalDays !== null && (
              <span className="pill" style={{ background: "#E5F3E5", color: "#2E6B2E" }}>{cadenceLabel(i.intervalDays)}</span>
            )}
            {scopeChips.length ? (
              <>
                {scopeChips.slice(0, 2).map((m) => (
                  <span key={m} className="pill" style={{ background: "#EDEBFA", color: "#4F45A3" }}>{m}</span>
                ))}
                {scopeChips.length > 2 && (
                  <span className="pill" style={{ background: "#EDEBFA", color: "#4F45A3" }}>+{scopeChips.length - 2}</span>
                )}
              </>
            ) : (
              <span className="pill" style={{ background: "#EEF1F5", color: "#94A3B8" }}>
                {assetType === "system" ? "All systems" : "All models"}
              </span>
            )}
            {/* Which system types this row belongs to. Only said when the type
                serves several - a row that appears under TOC and LC-MS alike
                must say so, or deleting it "here" surprises "there". */}
            {shared && (
              i.categoryScope.length ? (
                i.categoryScope.map((c) => (
                  <span key={c} className="pill" style={{ background: "#E0F0EE", color: "#0F6B5F" }}>{c}</span>
                ))
              ) : (
                <span className="pill" style={{ background: "#E0F0EE", color: "#0F6B5F" }}
                  title={`Appears under ${served.join(" and ")} alike - edit to scope it to one`}>
                  all {served.length} system types
                </span>
              )
            )}
            {i.parts.map((pt) => (
              <span key={`${pt.number}|${pt.name}`} className="mono" style={{ fontSize: 11, color: "#8A5410", background: "#FAF0DC", borderRadius: 4, padding: "1px 5px" }}>
                {pt.number ? `PN ${pt.number}` : pt.name}
                {pt.models?.length ? ` · ${pt.models.join("/")}` : ""}
              </span>
            ))}
          </div>
        </button>
        {/* A new variant on the same type - the LC-30's seal kit isn't the
            LC-20's, so each model's version is its own row. */}
        <button className="btn link" aria-label={`Duplicate ${i.name}`} title="Duplicate - e.g. a per-model variant with different parts"
          disabled={pending}
          onClick={() => openDuplicate(i)}
          style={{ fontSize: 12, padding: 4 }}>duplicate</button>
        {/* The same work on another module type - a leak check is a leak check
            whether it is a pump or the whole stack. */}
        <button className="btn link" aria-label={`Copy ${i.name} to another module type`} title="Copy to another type"
          disabled={pending}
          onClick={() => { setCopying(i); setCopyTo([]); setSaved(""); setError(""); }}
          style={{ fontSize: 12, padding: 4 }}>copy</button>
        <button className="btn link" aria-label={`Remove ${i.name}`} title="Remove" disabled={pending}
          onClick={() => {
            // A row serving several system types, removed from inside one of
            // them, is a scope question - not a delete. Straight delete only
            // when the row lives in exactly one place.
            const scopedHere = bandKey !== "system" && bandKey !== "__loose" && shared
              && effective.length > 1 && effective.some((c) => c.toLowerCase() === bandKey.toLowerCase());
            if (scopedHere) {
              setRemoving({ row: i, band: bandKey, served });
              setSaved(""); setError("");
              return;
            }
            if (window.confirm(`Remove "${i.name}"? Tasks and schedules already on units stay.`)) {
              startTransition(async () => { await deleteProcedure(i.id); });
            }
          }}
          style={{ fontSize: 14, padding: 4, color: "#A32D2D" }}>×</button>
      </div>
    );
  };

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <div className="card-title">Procedures &amp; maintenance</div>
        {/* How much of the book could travel with a licensed library. */}
        {items.length > 0 && (
          <span className="mut" style={{ fontSize: 10.5 }}>{tallyLine(tallyProvenance(items))}</span>
        )}
      </div>
      {/* The one fact that saves the copy/paste: definitions here apply
          themselves. Without this line, people write upkeep onto each system
          by hand and never find out they didn't have to. */}
      <div className="mut" style={{ fontSize: 12, margin: "4px 0 10px", maxWidth: 720 }}>
        Define work once - for a whole system type, a module type, or specific models. Anything
        with a cadence becomes a <b>maintenance schedule on every matching unit automatically</b>,
        existing and new; anything marked &ldquo;at intake&rdquo; is created as checkout work when
        a matching unit arrives. Nothing needs copying onto individual systems.
      </div>

      {/* Copy one procedure onto other module types. Several at once, because
          "this belongs on the stack and the detector too" is one thought. */}
      {copying && (
        <>
          <div className="scrim" onClick={() => setCopying(null)} />
          <div className="sheet" role="dialog" aria-modal="true" aria-label={`Copy ${copying.name}`}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>Copy &ldquo;{copying.name}&rdquo;</div>
              <button className="btn link" style={{ marginLeft: "auto", fontSize: 12 }}
                onClick={() => setCopying(null)}>close</button>
            </div>
            <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
              From {copying.assetType === "system" ? "System" : copying.assetType}. The timing, parts and notes
              come across; the model scope does not, since models belong to one type.
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 10 }}>
              {["system", ...assetTypes].filter((t) => t !== copying.assetType).map((t) => (
                <button key={t} type="button" className="pill"
                  onClick={() => setCopyTo((c) => (c.includes(t) ? c.filter((x) => x !== t) : [...c, t]))}
                  style={{
                    cursor: "pointer", border: "1px solid var(--line)",
                    background: copyTo.includes(t) ? "#172A4A" : "#fff",
                    color: copyTo.includes(t) ? "#fff" : "var(--slate)",
                  }}>{t === "system" ? "System" : t}</button>
              ))}
            </div>
            {error && <div style={{ fontSize: 12, color: "#A32D2D", marginBottom: 8 }}>{error}</div>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn sm" onClick={() => setCopying(null)} disabled={pending}>Cancel</button>
              <button className="btn sm primary" disabled={pending || !copyTo.length}
                onClick={() => {
                  setError("");
                  startTransition(async () => {
                    const res = await copyProcedureToTypes(copying.id, copyTo);
                    if (res?.error) { setError(res.error); return; }
                    const skipped = res.skipped?.length ? ` (already on ${res.skipped.join(", ")})` : "";
                    setSaved(`Copied to ${res.copied} type${res.copied === 1 ? "" : "s"}${skipped}`);
                    setCopying(null);
                  });
                }}>{pending ? "Copying..." : "Copy"}</button>
            </div>
          </div>
        </>
      )}

      {/* Filed under the wrong system type. The models and their makers stay
          exactly as they are - only the tag that decides where they appear moves. */}
      {moving && (
        <>
          <div className="scrim" onClick={() => setMoving(null)} />
          <div className="sheet" role="dialog" aria-modal="true" aria-label={`Move ${moving.assetType}`}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
              <div style={{ fontSize: 15, fontWeight: 700 }}>Move {moving.assetType}</div>
              <button className="btn link" style={{ marginLeft: "auto", fontSize: 12 }}
                onClick={() => setMoving(null)}>close</button>
            </div>
            <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
              Out of {moving.from}, into another system type. Every {moving.assetType} model keeps its name and
              its manufacturer; only where it is filed changes.
            </div>
            <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} aria-label="Move to system type"
              style={{ marginBottom: 10, fontSize: 13 }}>
              <option value="">Choose a system type...</option>
              {categories.filter((c) => c !== moving.from).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            {error && <div style={{ fontSize: 12, color: "#A32D2D", marginBottom: 8 }}>{error}</div>}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn sm" onClick={() => setMoving(null)} disabled={pending}>Cancel</button>
              <button className="btn sm primary" disabled={pending || !moveTo}
                onClick={() => {
                  setError("");
                  startTransition(async () => {
                    const res = await moveTypeToCategory(moving.assetType, moving.from, moveTo);
                    if (res?.error) { setError(res.error); return; }
                    setSaved(`${moving.assetType} moved to ${moveTo} - ${res.moved} model${res.moved === 1 ? "" : "s"} retagged`);
                    setMoving(null);
                  });
                }}>{pending ? "Moving..." : "Move"}</button>
            </div>
          </div>
        </>
      )}

      {/* Remove-from-one-place. The row serves several system types; deleting
          it outright would take it off all of them at once. */}
      {removing && (() => {
        const { row, band, served } = removing;
        const effective = row.categoryScope.length ? row.categoryScope : served;
        const rest = effective.filter((c) => c.toLowerCase() !== band.toLowerCase());
        const narrow = () => {
          setError("");
          startTransition(async () => {
            const res = await updateProcedure(row.id, {
              assetType: row.assetType, kind: row.kind, name: row.name, notes: row.notes,
              resultType: row.resultType, target: row.target ?? "", tolerancePct: row.tolerancePct ?? "",
              requiresNote: row.requiresNote, consumesPart: row.consumesPart,
              runsAtIntake: row.runsAtIntake, required: row.required,
              intervalDays: row.intervalDays,
              parts: row.parts, modelScope: row.modelScope, categoryScope: rest,
            }, false);
            if (res?.error) { setError(res.error); return; }
            setSaved(`"${row.name}" no longer applies under ${band}; still on ${rest.join(", ")}`);
            setRemoving(null);
          });
        };
        return (
          <>
            <div className="scrim" onClick={() => setRemoving(null)} />
            <div className="sheet" role="dialog" aria-modal="true" aria-label={`Remove ${row.name}`}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
                <div style={{ fontSize: 15, fontWeight: 700 }}>Remove &ldquo;{row.name}&rdquo;</div>
                <button className="btn link" style={{ marginLeft: "auto", fontSize: 12 }}
                  onClick={() => setRemoving(null)}>close</button>
              </div>
              <div className="mut" style={{ fontSize: 12, marginBottom: 12 }}>
                This procedure applies under {effective.join(" and ")}. Tasks and schedules
                already on units stay either way.
              </div>
              {error && <div style={{ fontSize: 12, color: "#A32D2D", marginBottom: 8 }}>{error}</div>}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
                <button className="btn sm" onClick={() => setRemoving(null)} disabled={pending}>Cancel</button>
                <button className="btn sm" disabled={pending} style={{ color: "#A32D2D" }}
                  onClick={() => {
                    startTransition(async () => { await deleteProcedure(row.id); setRemoving(null); });
                  }}>Delete from all of them</button>
                <button className="btn sm primary" onClick={narrow} disabled={pending}>
                  {pending ? "Saving..." : `Remove from ${band} only`}
                </button>
              </div>
            </div>
          </>
        );
      })()}

      <div className="seg" role="group" aria-label="Filter procedures" style={{ marginBottom: 10, flexWrap: "wrap" }}>
        {FILTERS.map((f) => (
          <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>
            {f.label}
          </button>
        ))}
      </div>
      {saved && <div style={{ fontSize: 12, color: "#2E6B2E", fontWeight: 700, marginBottom: 8 }}>{saved} ✓</div>}

      {/* One accordion, the Catalog's shape: System first, then a band per
          system category. An open band shows every module type inside it
          EXPANDED - the old second accordion meant two clicks to see any row,
          which read as an empty page. */}
      {BANDS.map((band) => {
        const bandRows = band.types.flatMap((ty) => rowsIn(band.key, ty));
        const bandOpen = openBand === band.key;
        const bandRecur = bandRows.filter((i) => i.intervalDays !== null).length;
        return (
        <div key={band.key}>
          <div className="row-hover" onClick={() => setOpenBand(bandOpen ? null : band.key)}
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 4px", cursor: "pointer", borderTop: "1px solid var(--line)" }}>
            <span style={{ fontSize: 15, fontWeight: 800, color: "var(--navy)", letterSpacing: "-0.2px" }}>
              {band.key === "system" ? "System-wide" : band.label}
            </span>
            <span className="mut" style={{ fontSize: 12 }}>
              {bandRows.length
                ? `${bandRows.length} procedure${bandRows.length === 1 ? "" : "s"}${bandRecur ? ` · ${bandRecur} maintenance` : ""}`
                : "no procedures yet"}
              {band.key !== "system" && ` · ${band.types.length} type${band.types.length === 1 ? "" : "s"}`}
            </span>
            <span className="mut" style={{ marginLeft: "auto", fontSize: 12 }}>{bandOpen ? "▴" : "▾"}</span>
          </div>
          {bandOpen && (
            <div style={{ padding: "10px 0 12px" }}>
              {band.subtitle && <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>{band.subtitle}</div>}
              {band.types.map((bandType) => {
                const g = GROUPS.find((x) => x.type === bandType) ?? { type: bandType, label: bandType, subtitle: undefined };
                const listKey = `${band.key}::${g.type}`;
                const all = applyOrder(listKey, rowsIn(band.key, g.type));
                const list = all.filter((i) => passesFilter(i, filter));
                const hidden = all.length - list.length;
                const isSystemBand = band.key === "system";
                return (
                  <div key={g.type} style={{ marginBottom: 14 }}>
                    {/* The System band holds one pseudo-type; a second "System"
                        heading inside it said nothing. */}
                    {!isSystemBand && (
                      <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "0 0 6px" }}>
                        <span style={{ fontSize: 13, fontWeight: 700 }}>{g.label}</span>
                        <span className="mut" style={{ fontSize: 11 }}>
                          {all.length ? `${all.length} procedure${all.length === 1 ? "" : "s"}` : "none yet"}
                        </span>
                        {/* Filed in the wrong place: move the type, keeping its
                            models and their makers. Only inside a real category. */}
                        {band.key !== "__loose" && (
                          <button className="btn link" style={{ fontSize: 11 }} disabled={pending}
                            onClick={() => {
                              setMoving({ assetType: g.type, from: band.key });
                              setMoveTo(""); setSaved(""); setError("");
                            }}>move</button>
                        )}
                      </div>
                    )}
                    {all.length > 0 && list.length === 0 && (
                      <div className="mut" style={{ fontSize: 12, marginBottom: 6 }}>
                        {hidden} hidden by the {FILTERS.find((f) => f.key === filter)?.label} filter.
                      </div>
                    )}
                    <div ref={(el) => { listRefs.current[listKey] = el; }}>
                      {list.map((i) => renderRow(i, g.type, band.key, listKey, list.map((x) => x.id)))}
                    </div>
                    {list.length > 0 && hidden > 0 && (
                      <div className="mut" style={{ fontSize: 11, marginBottom: 6 }}>
                        +{hidden} more hidden by the filter.
                      </div>
                    )}
                    <button className="btn sm" onClick={() => openAdd(g.type, band.key)}
                      style={{ width: "100%", border: "1px dashed var(--sky)", background: "#F7FBFE", color: "#1D6396" }}>
                      ＋ Procedure{isSystemBand ? " · system-wide" : ` · ${g.label}`}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        );
      })}

      {sheet && (
        <>
          <div className="scrim" onClick={() => setSheet(null)} />
          <div className="sheet" ref={sheetRef} role="dialog" aria-modal="true"
            aria-label={`${sheet.id ? "Edit" : "New"} procedure`}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--navy)" }}>
                {sheet.id ? "Edit" : "New"} · {isSystem ? "System" : sheet.assetType}
              </div>
              <div className="seg" role="group" aria-label="Procedure kind" style={{ marginLeft: "auto" }}>
                {(["task", "test"] as const).map((k) => (
                  <button key={k} type="button" aria-pressed={draft.kind === k} onClick={() => setDraft({ ...draft, kind: k })}>
                    {k === "task" ? "☐ Task" : "◎ Test"}
                  </button>
                ))}
              </div>
            </div>

            <label>Name *</label>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder={draft.kind === "task" ? "e.g. Replace inlet septum" : "e.g. Flow Check"}
              style={{ marginBottom: 10 }} />

            {draft.kind === "test" ? (
              <div style={{ marginBottom: 10 }}>
                <label>Result</label>
                <div className="seg" role="group" aria-label="Result type" style={{ flexWrap: "wrap" }}>
                  {RESULT_TYPES.map((rt) => (
                    <button key={rt} type="button" aria-pressed={draft.resultType === rt}
                      onClick={() => setDraft({ ...draft, resultType: rt })}>
                      {RESULT_LABEL[rt]}
                    </button>
                  ))}
                </div>
                {draft.resultType === "measured" && (
                  <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                    <div style={{ flex: 2 }}>
                      <label>Target</label>
                      <input value={draft.target} onChange={(e) => setDraft({ ...draft, target: e.target.value })}
                        placeholder="e.g. 5 mL/min or 2.0 C" />
                    </div>
                    <div style={{ flex: 1 }}>
                      <label>± Tolerance %</label>
                      <input value={draft.tolerancePct} inputMode="decimal"
                        onChange={(e) => setDraft({ ...draft, tolerancePct: e.target.value })} placeholder="10" />
                    </div>
                  </div>
                )}
                {draft.resultType === "note" && (
                  <div style={{ marginTop: 8 }}>
                    <label>What to record</label>
                    <input value={draft.target} onChange={(e) => setDraft({ ...draft, target: e.target.value })}
                      placeholder="e.g. record lamp hours" />
                  </div>
                )}
              </div>
            ) : (
              <div style={{ marginBottom: 10 }}>
                {/* "Inspect and/or replace X" has two honest endings and a bare
                    checkmark records neither. On, the generated task closes only
                    by recording which happened - like a test records its number. */}
                <label style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 12, margin: "0 0 8px", fontWeight: 400, color: "var(--ink)" }}>
                  <input type="checkbox" checked={draft.resultType === "inspect_replace"} style={{ width: 15, height: 15, marginTop: 2 }}
                    onChange={(e) => setDraft({ ...draft, resultType: e.target.checked ? "inspect_replace" : "pass_fail" })} />
                  <span>
                    Inspect / Replace outcome
                    <span className="mut" style={{ display: "block", fontSize: 11 }}>
                      The task can&apos;t be closed until whoever did it records which happened -
                      inspected (what was found) or replaced (what went in). Both are documented
                      with name and time, like a test result.
                    </span>
                  </span>
                </label>
                <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, margin: 0 }}>
                    <input type="checkbox" checked={draft.requiresNote} style={{ width: 15, height: 15 }}
                      onChange={(e) => setDraft({ ...draft, requiresNote: e.target.checked })} />
                    Require a note
                  </label>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, margin: 0 }}>
                    <input type="checkbox" checked={draft.consumesPart} style={{ width: 15, height: 15 }}
                      onChange={(e) => setDraft({ ...draft, consumesPart: e.target.checked })} />
                    Consumes a part
                  </label>
                </div>
              </div>
            )}

            {/* When it runs. Both off = invalid; the error lands here. */}
            <label>When it runs *</label>
            <div style={{
              border: `1px solid ${!timingValid && error ? "#A32D2D" : "var(--line)"}`,
              borderRadius: 8, background: "#fff", padding: "8px 10px", marginBottom: 10,
            }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, margin: 0 }}>
                <input type="checkbox" checked={draft.runsAtIntake} style={{ width: 15, height: 15 }}
                  onChange={(e) => setDraft({ ...draft, runsAtIntake: e.target.checked })} />
                At intake - created once when a {isSystem ? "system" : "unit of this type"} is added
              </label>
              <>
                  <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, margin: "8px 0 0" }}>
                    <input type="checkbox" checked={draft.repeats} style={{ width: 15, height: 15 }}
                      onChange={(e) => setDraft({ ...draft, repeats: e.target.checked })} />
                    Maintenance - repeats on a cadence, scheduled on every {isSystem ? "system" : "unit"} it covers, existing and new
                  </label>
                  {draft.repeats && (
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 8, paddingLeft: 21 }}>
                      <select value={draft.intervalDays} onChange={(e) => setDraft({ ...draft, intervalDays: e.target.value })}
                        style={{ width: "auto", fontSize: 12 }} aria-label="Cadence preset">
                        {CADENCES.map((c) => <option key={c.days} value={c.days}>{c.label}</option>)}
                        {!CADENCES.some((c) => c.days === draft.intervalDays) && (
                          <option value={draft.intervalDays}>every {draft.intervalDays} days</option>
                        )}
                      </select>
                      <input type="number" min={1} max={3650} value={draft.intervalDays} inputMode="numeric"
                        onChange={(e) => setDraft({ ...draft, intervalDays: e.target.value })}
                        aria-label="Cadence in days" style={{ width: 76, fontSize: 12 }} />
                      <span className="mut" style={{ fontSize: 11 }}>days</span>
                    </div>
                  )}
                </>
            </div>

            <label style={{ display: "flex", alignItems: "flex-start", gap: 6, fontSize: 12, margin: "0 0 10px", fontWeight: 400, color: "var(--ink)" }}>
              <input type="checkbox" checked={draft.required} style={{ width: 15, height: 15, marginTop: 2 }}
                onChange={(e) => setDraft({ ...draft, required: e.target.checked })} />
              <span>
                Required for sign-off
                <span className="mut" style={{ display: "block", fontSize: 11 }}>
                  {draft.kind === "test"
                    ? "Nobody can sign off until this test is done and a report is filed against it."
                    : "Nobody can sign off until this is done."}
                </span>
              </span>
            </label>

            {/* Which qualification this belongs to, for regulated systems. A
                grouping, not a behavior change - the work runs the same; the
                binder and the GxP standing read the tag. */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
              <label style={{ margin: 0 }}>Qualification</label>
              <div className="seg" role="group" aria-label="Qualification">
                {["", ...QUALIFICATIONS].map((q) => (
                  <button key={q || "none"} type="button" aria-pressed={draft.qualification === q}
                    onClick={() => setDraft({ ...draft, qualification: q })}>
                    {q || "None"}
                  </button>
                ))}
              </div>
              <span className="mut" style={{ fontSize: 11 }}>
                Groups this under IQ/OQ/PQ on regulated (GxP) systems. Others ignore it.
              </span>
            </div>

            {/* Whose words these are. Asked here, once, while the procedure is
                being written - the only moment the answer is actually known.
                Decides whether it can travel with a licensed library. */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
              <label style={{ margin: 0 }}>Where it came from</label>
              <div className="seg" role="group" aria-label="Where it came from">
                {["", ...PROVENANCE_CHOICES].map((c) => (
                  <button key={c || "none"} type="button" aria-pressed={draft.provenance === c}
                    onClick={() => setDraft({ ...draft, provenance: c })}>
                    {c ? PROVENANCE_LABEL[c as keyof typeof PROVENANCE_LABEL] : "Not saying"}
                  </button>
                ))}
              </div>
            </div>
            <div className="mut" style={{ fontSize: 11, marginBottom: 10 }}>
              {PROVENANCE_BLURB[(draft.provenance || "") as keyof typeof PROVENANCE_BLURB]}
            </div>

            {/* Only on edit, and only when the timing actually changed: what
                happens to existing units, with the opt-in to apply it now. */}
            {timingChange && (
              <div style={{ fontSize: 12, padding: "8px 10px", borderRadius: 8, background: "#FAF0DC", color: "#8A5410", marginBottom: 10 }}>
                {timingChange === "changed" && (
                  <>Existing units keep their current cadence; only units added from now on get the new one.</>
                )}
                {timingChange === "added" && (
                  <>Only units added from now on get this schedule; existing units stay unscheduled.</>
                )}
                {timingChange === "removed" && (
                  <>Existing units keep their schedules; this only stops new units from getting one.</>
                )}
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, margin: "6px 0 0", fontWeight: 700 }}>
                  <input type="checkbox" checked={applyNow} style={{ width: 15, height: 15 }}
                    onChange={(e) => setApplyNow(e.target.checked)} />
                  {timingChange === "changed" && "Also re-time existing units now"}
                  {timingChange === "added" && "Also schedule existing units now"}
                  {timingChange === "removed" && "Also remove existing schedules now (their tasks stay)"}
                </label>
              </div>
            )}

            <label>Steps / notes</label>
            <textarea value={draft.notes} rows={2}
              onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              placeholder="What doing this involves (optional)"
              style={{ width: "100%", marginBottom: 10, resize: "vertical", fontSize: 13 }} />

            {/* The steps as boxes rather than as a paragraph. Every task this
                makes - at intake and on every cycle - arrives with them
                already ticked off nothing, so a fourteen-step teardown stops
                being one checkbox somebody ticks at the end. */}
            <label>Checklist <span className="mut" style={{ fontWeight: 400 }}>(one step per line)</span></label>
            <textarea value={draft.checklist} rows={5}
              onChange={(e) => setDraft({ ...draft, checklist: e.target.value })}
              placeholder={"Remove & Sonicate:\nLow-Pressure Funnel Assembly\nHigh-Pressure Funnel Assembly"}
              style={{ width: "100%", marginBottom: 4, resize: "vertical", fontSize: 13 }} />
            <div className="mut" style={{ fontSize: 10.5, marginBottom: 10 }}>
              End a line with a colon to make it a section label instead of a tick box.
              {(() => {
                const n = parseChecklist(draft.checklist).filter((l) => !l.heading).length;
                return n ? ` ${n} box${n === 1 ? "" : "es"} on every task this makes.` : "";
              })()}
            </div>

            <label>Parts it takes</label>
            <div style={{ marginBottom: 10 }}>
              {draft.parts.map((pt, idx) => {
                const partModels = pt.models ?? [];
                const modelPool = (modelOptions[sheet.assetType] ?? []).filter((m) => !partModels.includes(m));
                const setPart = (patch: Partial<ProcPart>) =>
                  setDraft({ ...draft, parts: draft.parts.map((x, i) => (i === idx ? { ...x, ...patch } : x)) });
                return (
                <div key={idx} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "6px 8px", marginBottom: 6 }}>
                  <div style={{ display: "flex", gap: 6 }}>
                    {/* How many the job takes. An MS120's annual oil change
                        needs two bottles, and one arriving is the job not
                        getting done - so this reaches the part that gets
                        ordered, not just the wording of the task. Blank reads
                        as 1, which is what every part meant before this. */}
                    <input type="number" min={1} max={999} value={pt.qty ?? ""} placeholder="1"
                      aria-label="How many this job takes"
                      onChange={(e) => {
                        const n = parseInt(e.target.value, 10);
                        setPart({ qty: Number.isFinite(n) && n > 1 ? n : undefined });
                      }}
                      style={{ width: 56, fontSize: 13 }} />
                    <PartNumberField value={pt.number} style={{ flex: 1, fontSize: 13 }}
                      onChange={(number) => setPart({ number })}
                      onPick={(part) => setPart({ number: part.partNumber, name: pt.name.trim() || part.name })} />
                    <input value={pt.name} placeholder="Name (optional)"
                      onChange={(e) => setPart({ name: e.target.value })}
                      style={{ flex: 1, fontSize: 13 }} />
                    <button className="btn link" aria-label="Remove part" style={{ color: "#A32D2D", fontSize: 13 }}
                      onClick={() => setDraft({ ...draft, parts: draft.parts.filter((_, i) => i !== idx) })}>×</button>
                  </div>
                  {/* Which models take THIS part number. One procedure, one
                      mapping: seals get inspected on every pump, but the LC-20's
                      kit isn't the LC-30's - each unit's work carries only the
                      parts tagged for its model. */}
                  {!isSystem && (modelOptions[sheet.assetType] ?? []).length > 0 && (
                    <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap", marginTop: 6 }}>
                      <span className="mut" style={{ fontSize: 11 }}>fits</span>
                      {partModels.length === 0 && (
                        <span className="pill" style={{ background: "#EEF1F5", color: "#94A3B8" }}>any model</span>
                      )}
                      {partModels.map((m) => (
                        <span key={m} className="pill" style={{ background: "#EDEBFA", color: "#4F45A3", display: "inline-flex", alignItems: "center", gap: 4 }}>
                          {m}
                          <button type="button" className="chip-x" aria-label={`This part no longer fits ${m}`}
                            onClick={() => setPart({ models: partModels.filter((x) => x !== m) })}
                            style={{ border: "none", background: "none", color: "inherit", cursor: "pointer", padding: 0, fontSize: 12, lineHeight: 1 }}>×</button>
                        </span>
                      ))}
                      {modelPool.length > 0 && (
                        <select value="" aria-label="Limit this part to a model"
                          onChange={(e) => { if (e.target.value) setPart({ models: [...partModels, e.target.value] }); }}
                          style={{ width: "auto", fontSize: 11, padding: "2px 6px" }}>
                          <option value="">+ model...</option>
                          {modelPool.map((m) => <option key={m} value={m}>{m}</option>)}
                        </select>
                      )}
                    </div>
                  )}
                </div>
                );
              })}
              <button type="button" className="btn sm"
                onClick={() => setDraft({ ...draft, parts: [...draft.parts, { name: "", number: "" }] })}>
                ＋ Part
              </button>
            </div>

            {isSystem ? (
              <>
                <label>System types</label>
                <ScopeField scope={draft.categoryScope} options={categories}
                  onChange={(next) => setDraft({ ...draft, categoryScope: next })} />
                <div className="mut" style={{ fontSize: 11, marginTop: -4, marginBottom: 8 }}>
                  Leave empty and it covers every system in the workspace - which is rarely
                  what an annual PM means.
                </div>
              </>
            ) : (
              <>
                <label>Models</label>
                <ScopeField scope={draft.modelScope} options={modelOptions[sheet.assetType] ?? []}
                  onChange={(next) => setDraft({ ...draft, modelScope: next })} />
                <div className="mut" style={{ fontSize: 11, marginTop: 4 }}>
                  Same work, different part number per model? Keep ONE procedure covering all of
                  them and tag each part above with the models it fits. Duplicate the procedure
                  only when the work itself differs by model.
                </div>
                {/* Only when the type serves several system types is there a
                    question to answer - a Degasser only LC-MS uses needs no
                    scope. This is what keeps the TOC sampler's procedures off
                    the LC-MS sampler and vice versa. */}
                {(categoriesByType[sheet.assetType] ?? []).length > 1 && (
                  <div style={{ marginTop: 10 }}>
                    <label>System types it belongs to</label>
                    <ScopeField scope={draft.categoryScope} options={categoriesByType[sheet.assetType] ?? []}
                      onChange={(next) => setDraft({ ...draft, categoryScope: next })} />
                    <div className="mut" style={{ fontSize: 11, marginTop: 4 }}>
                      Empty covers every system type a {sheet.assetType.toLowerCase()} serves
                      ({(categoriesByType[sheet.assetType] ?? []).join(", ")}).
                    </div>
                  </div>
                )}
              </>
            )}

            {/* The live sentence: what this will actually do. */}
            <div style={{
              fontSize: 12, marginTop: 10, padding: "7px 10px", borderRadius: 8,
              background: sentence ? "#F1F4F8" : "#FBE9E9",
              color: sentence ? "var(--slate)" : "#A32D2D",
              fontWeight: sentence ? 400 : 700,
            }}>
              {sentence ?? "Never runs - switch on at least one timing above."}
            </div>
            {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{error}</div>}

            <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
              <button className="btn sm" onClick={() => setSheet(null)} disabled={pending}>Cancel</button>
              <button className="btn sm accent" onClick={save} disabled={pending || !draft.name.trim()}>
                {pending ? "Saving..." : "Save procedure"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
