"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { updateProcedure, deleteProcedure, copyProceduresToModel, reorderProcedures,
  copyProcedureToTypes, moveTypeToCategory,
} from "@/app/actions";
import { summarizeItem } from "@/lib/checkout";
import { cadenceLabel } from "@/lib/pm";
import { type ProcPart } from "@/lib/procedures";
import { needsAcceptanceReview, parseAcceptance } from "@/lib/testResult";
import ProcedureDialog, { type ProcedureSheet } from "./ProcedureDialog";
import { procedureRole, ROLE_LABEL, ROLE_TONE } from "@/lib/procedureRole";
import { QUAL_LABEL } from "@/lib/gxp";
import ProvenanceChip from "./ProvenanceChip";
import { PROVENANCE_BLURB, PROVENANCE_CHOICES, PROVENANCE_LABEL, tallyLine, tallyProvenance } from "@/lib/provenance";
import type { Tone } from "@/lib/tones";
import Dialog from "@/components/ui/Dialog";
import { confirmDialog } from "@/components/ui/ConfirmDialog";
import { Dot, FacetStrip, Legend, PageHead } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

export type ProcedureRow = {
  id: number; assetType: string; kind: string; name: string; notes: string; position: number;
  resultType: string; target: string | null; tolerancePct: string | null;
  /** The structured spec (JSON, lib/testResult.Acceptance). "" = legacy prose. */
  acceptance?: string;
  requiresNote: boolean; consumesPart: boolean;
  runsAtIntake: boolean; intervalDays: number | null; required: boolean;
  /** Tests only: a report must be on the result before sign-off. */
  needsReport?: boolean;
  /** Usage cadence ("every 2000 injections") - displayed, never cron-run. */
  usageEvery?: number | null; usageUnit?: string;
  qualification: string;
  parts: ProcPart[]; modelScope: string[]; categoryScope: string[];
  checklist: string;
  /** '' | original | facts | oem - see lib/provenance. */
  provenance?: string;
};

const KIND_GLYPH: Record<string, { glyph: string; tone: Tone }> = {
  task: { glyph: "☐", tone: "info" },
  test: { glyph: "◎", tone: "accent" },
};

const FILTERS = [
  { key: "all", label: "All" },
  { key: "intake", label: "At intake" },
  { key: "recurring", label: "Maintenance" },
  { key: "tests", label: "Tests" },
  { key: "tasks", label: "Tasks" },
  { key: "review", label: "Needs review" },
] as const;
type FilterKey = typeof FILTERS[number]["key"];

const passesFilter = (p: ProcedureRow, f: FilterKey) =>
  f === "all" ? true
    : f === "intake" ? p.runsAtIntake
    : f === "recurring" ? p.intervalDays !== null || !!p.usageEvery
    : f === "tests" ? p.kind === "test"
    // Tests whose limits still live in prose - moved into structured criteria
    // by hand, never parsed automatically. See lib/testResult.
    : f === "review" ? needsAcceptanceReview({ ...p, acceptance: p.acceptance ?? "" })
    : p.kind === "task";

// The add/edit dialog itself - five stepped sections, the scope ladder, the
// structured acceptance editor - lives in ProcedureDialog.tsx (prompt B3).
// This panel owns the catalog LIST: bands, filters, reorder, copy and move.

/**
 * The one procedure catalog: what gets done to equipment, per module type. A
 * row's badges say everything - kind, when it fires, scope, parts - and every
 * badge maps to a control in the one sheet that both adds and edits.
 */
export default function ProceduresPanel({ items, assetTypes, modelOptions, modelsByCategory, categories, categoriesByType, focus, copyFrom = [] }: {
  items: ProcedureRow[];
  assetTypes: string[]; // from Settings > Catalog
  modelOptions: Record<string, string[]>;
  /** assetType -> system type -> that type's models, for the scope ladder's counts. */
  modelsByCategory?: Record<string, Record<string, string[]>>;
  categories: string[];                            // system categories, from the catalog
  categoriesByType: Record<string, string[]>;      // which categories each module type serves
  /**
   * One-model mode, for the model's own page: only the focused type shows, a
   * new procedure starts scoped to this model, and editing a shared procedure
   * offers "apply to all covered models" vs "only this one" - the latter forks
   * (see actions.forkProcedureForModel).
   */
  focus?: { assetType: string; model: string };
  /**
   * Sibling models to seed this one from, with how many of their procedures
   * this model does not have. Focus mode only - see the copy row below.
   */
  copyFrom?: { name: string; count: number }[];
}) {
  const [openBand, setOpenBand] = useState<string | null>(focus ? "__focus" : "system");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [sheet, setSheet] = useState<ProcedureSheet | null>(null);
  // Seeding this model from a sibling: which one, and what came of it.
  const [seedFrom, setSeedFrom] = useState("");
  const [seedNote, setSeedNote] = useState("");
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

  // System first - instrument-level procedures run once per system. Types with
  // rows but no catalog entry still render, so nothing predating the catalog
  // goes invisible. Order is the catalog's; it never reshuffles by content.
  const GROUPS: { type: string; label: string; subtitle?: string }[] = focus
    ? [{ type: focus.assetType, label: focus.assetType }]
    : [
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
    // One band, always open, in one-model mode - the category split is about
    // navigating a whole book, and this page IS one entry of it.
    if (focus) return [{ key: "__focus", label: focus.assetType, types: [focus.assetType], subtitle: "" }];
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories, categoriesByType, assetTypes, items, focus?.assetType]);

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
    if (bandKey === "system" || bandKey === "__loose" || bandKey === "__focus" || type === "system") return all;
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
    const scoped = bandKey && bandKey !== "system" && bandKey !== "__loose" && bandKey !== "__focus" && served.length > 1;
    setError("");
    setSheet({ assetType, bandCategory: scoped ? bandKey : undefined });
  };
  const openEdit = (i: ProcedureRow) => {
    setError("");
    setSheet({ assetType: i.assetType, id: i.id });
  };
  // A new procedure pre-filled from an existing one, on the same type. This is
  // how "the LC-30 takes different work than the LC-20" gets its own row:
  // duplicate, narrow the model scope, change what differs. The system-type
  // scope carries over - a TOC variant belongs to TOC until said otherwise.
  const openDuplicate = (i: ProcedureRow) => {
    setError("");
    setSheet({ assetType: i.assetType, duplicateFrom: i.id });
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
          <span className="drag-handle mut t-body" aria-label="Drag to reorder" tabIndex={0}
            onPointerDown={(e) => startDrag(e, listKey, assetType, listIds, i.id)} onPointerMove={moveDrag}
            onPointerUp={endDrag} onPointerCancel={endDrag}
            style={{ userSelect: "none", padding: "2px 2px" }}>⠿</span>
        )}
        {/* One dot says what the row IS (see the legend); required reads red. */}
        <span title={i.required ? "Required before sign-off" : ROLE_LABEL[role]}>
          <Dot tone={i.required ? "bad" : ROLE_TONE[role]} />
        </span>
        <button onClick={() => openEdit(i)} disabled={pending}
          style={{ flex: 1, minWidth: 0, textAlign: "left", border: "none", background: "none", padding: 0, cursor: "pointer" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
            <span className="t-body" style={{ fontWeight: 700, color: "var(--ink)" }}>{i.name}</span>
            {/* The one pill: the cadence when it has one, else what it is. */}
            {i.intervalDays !== null
              ? <span className={`pill ${ROLE_TONE[role]}`}>{cadenceLabel(i.intervalDays)}</span>
              : i.usageEvery && i.usageUnit
                ? <span className={`pill ${ROLE_TONE[role]}`}>every {i.usageEvery} {i.usageUnit}</span>
                : <span className={`pill ${ROLE_TONE[role]}`}>{ROLE_LABEL[role]}</span>}
          </div>
          {i.notes && (
            <div className="mut t-meta" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{i.notes}</div>
          )}
          {/* Everything else the pills used to shout, as one quiet line. */}
          <div className="mut t-meta" style={{ marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {[
              (i.kind === "test" || summarizeItem({ ...i }) !== "Done / not done") ? summarizeItem({ ...i }) : "",
              i.required ? "required" : "",
              i.qualification ? `${i.qualification} on GxP` : "",
              scopeChips.length
                ? scopeChips.slice(0, 3).join(", ") + (scopeChips.length > 3 ? ` +${scopeChips.length - 3}` : "")
                : (assetType === "system" ? "all systems" : "all models"),
              shared
                ? (i.categoryScope.length ? i.categoryScope.join(", ") : `all ${served.length} system types`)
                : "",
              i.parts.length
                ? i.parts.map((pt) => (pt.number ? `PN ${pt.number}` : pt.name)).join(", ")
                : "",
            ].filter(Boolean).join(" · ")}
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
            void (async () => {
              if (!(await confirmDialog({
                title: `Remove "${i.name}"?`,
                body: "Tasks and schedules already on units stay.",
                action: "Delete procedure", tone: "bad",
              }))) return;
              startTransition(async () => {
                await deleteProcedure(i.id);
                toast({ message: `Deleted "${i.name}"` });
              });
            })();
          }}
          style={{ fontSize: 14, padding: 4, color: "var(--t-bad-fg)" }}>×</button>
      </div>
    );
  };

  return (
    <div>
      <PageHead title="Procedures & maintenance"
        sub={items.length > 0 ? tallyLine(tallyProvenance(items)) : undefined} />
      {/* The one fact that saves the copy/paste: definitions here apply
          themselves. Without this line, people write upkeep onto each system
          by hand and never find out they didn't have to. */}
      <div className="mut t-small" style={{ margin: "4px 0 10px", maxWidth: 720 }}>
        Define work once - for a whole system type, a module type, or specific models. Anything
        with a cadence becomes a <b>maintenance schedule on every matching unit automatically</b>,
        existing and new; anything marked &ldquo;at intake&rdquo; is created as checkout work when
        a matching unit arrives. Nothing needs copying onto individual systems.
      </div>

      {/* Two sibling models are usually the same job with three differences.
          Copy the sibling's book across, then edit the differences here - the
          copies belong to this model alone, so editing one never touches the
          model it came from. */}
      {focus && copyFrom.length > 0 && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10, padding: "8px 10px", borderRadius: 8, background: "#F5F2FB" }}>
          <label style={{ margin: 0 }}>Copy from</label>
          <select value={seedFrom} onChange={(e) => { setSeedFrom(e.target.value); setSeedNote(""); }}
            aria-label="Copy procedures from" className="t-small" style={{ width: "auto" }}>
            <option value="">another model...</option>
            {copyFrom.map((m) => (
              <option key={m.name} value={m.name}>{m.name} ({m.count} to copy)</option>
            ))}
          </select>
          <button className="btn sm accent" disabled={pending || !seedFrom}
            onClick={() => {
              setError(""); setSeedNote("");
              startTransition(async () => {
                const res = await copyProceduresToModel(focus.assetType, seedFrom, focus.model);
                if (res?.error) { setError(res.error); return; }
                setSeedNote(`Copied ${res.copied} from ${seedFrom}`
                  + `${res.skipped ? ` · ${res.skipped} already covered` : ""}`
                  + `${res.applied ? ` · scheduled on ${res.applied} unit${res.applied === 1 ? "" : "s"}` : ""}`);
                setSeedFrom("");
              });
            }}>
            {pending ? "Copying..." : `Copy to ${focus.model}`}
          </button>
          <span className="mut t-meta">
            {focus.model} gets its own copies - edit them here without touching the model they came from.
          </span>
          {seedNote && <span className="t-small" style={{ color: "var(--t-good-fg)", fontWeight: 700, width: "100%" }}>{seedNote} ✓</span>}
        </div>
      )}

      {/* Copy one procedure onto other module types. Several at once, because
          "this belongs on the stack and the detector too" is one thought. */}
      {copying && (
        <Dialog open onClose={() => setCopying(null)} title={`Copy “${copying.name}”`}
          context={`From ${copying.assetType === "system" ? "System" : copying.assetType}. The timing, parts and notes come across; the model scope does not, since models belong to one type.`}
          footer={
            <>
              <span className={`dialog-status${error ? " err" : ""}`}>{error}</span>
              <button className="btn" onClick={() => setCopying(null)} disabled={pending}>Cancel</button>
              <button className="btn primary" disabled={pending || !copyTo.length}
                onClick={() => {
                  setError("");
                  startTransition(async () => {
                    const res = await copyProcedureToTypes(copying.id, copyTo);
                    if (res?.error) { setError(res.error); return; }
                    const skipped = res.skipped?.length ? ` (already on ${res.skipped.join(", ")})` : "";
                    setSaved(`Copied to ${res.copied} type${res.copied === 1 ? "" : "s"}${skipped}`);
                    setCopying(null);
                  });
                }}>{pending ? "Copying..." : "Copy procedure"}</button>
            </>
          }>
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
        </Dialog>
      )}

      {/* Filed under the wrong system type. The models and their makers stay
          exactly as they are - only the tag that decides where they appear moves. */}
      {moving && (
        <Dialog open onClose={() => setMoving(null)} title={`Move ${moving.assetType}`}
          context={`Out of ${moving.from}, into another system type. Every ${moving.assetType} model keeps its name and its manufacturer; only where it is filed changes.`}
          footer={
            <>
              <span className={`dialog-status${error ? " err" : ""}`}>{error}</span>
              <button className="btn" onClick={() => setMoving(null)} disabled={pending}>Cancel</button>
              <button className="btn primary" disabled={pending || !moveTo}
                onClick={() => {
                  setError("");
                  startTransition(async () => {
                    const res = await moveTypeToCategory(moving.assetType, moving.from, moveTo);
                    if (res?.error) { setError(res.error); return; }
                    setSaved(`${moving.assetType} moved to ${moveTo} - ${res.moved} model${res.moved === 1 ? "" : "s"} retagged`);
                    setMoving(null);
                  });
                }}>{pending ? "Moving..." : `Move ${moving.assetType}`}</button>
            </>
          }>
            <select value={moveTo} onChange={(e) => setMoveTo(e.target.value)} aria-label="Move to system type"
              className="t-body" style={{ marginBottom: 10 }}>
              <option value="">Choose a system type...</option>
              {categories.filter((c) => c !== moving.from).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
        </Dialog>
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
              acceptance: parseAcceptance(row.acceptance ?? ""),
              requiresNote: row.requiresNote, consumesPart: row.consumesPart,
              runsAtIntake: row.runsAtIntake, required: row.required,
              needsReport: row.needsReport ?? false,
              intervalDays: row.intervalDays,
              usage: row.usageEvery && row.usageUnit ? { every: row.usageEvery, unit: row.usageUnit } : null,
              qualification: row.qualification, checklist: row.checklist, provenance: row.provenance,
              parts: row.parts, modelScope: row.modelScope, categoryScope: rest,
            }, false);
            if (res?.error) { setError(res.error); return; }
            setSaved(`"${row.name}" no longer applies under ${band}; still on ${rest.join(", ")}`);
            setRemoving(null);
          });
        };
        return (
          <Dialog open size="sm" onClose={() => setRemoving(null)} title={`Remove “${row.name}”`}
            context={`This procedure applies under ${effective.join(" and ")}. Tasks and schedules already on units stay either way.`}
            footer={
              <>
                <span className={`dialog-status${error ? " err" : ""}`}>{error}</span>
                <button className="btn" onClick={() => setRemoving(null)} disabled={pending}>Cancel</button>
                <button className="btn link danger" disabled={pending}
                  onClick={() => {
                    startTransition(async () => {
                      await deleteProcedure(row.id);
                      toast({ message: `Deleted "${row.name}"` });
                      setRemoving(null);
                    });
                  }}>Delete from all of them</button>
                <button className="btn primary" onClick={narrow} disabled={pending}>
                  {pending ? "Saving..." : `Remove from ${band} only`}
                </button>
              </>
            }>
            <span />
          </Dialog>
        );
      })()}

      <FacetStrip
        facets={FILTERS.map((f) => ({
          key: f.key, label: f.label,
          count: f.key === "all" ? items.length : items.filter((i) => passesFilter(i, f.key)).length || undefined,
          on: filter === f.key,
        }))}
        onToggle={(k) => setFilter(k as FilterKey)}
      />
      <div style={{ height: 8 }} />
      {saved && <div className="t-small" style={{ color: "var(--t-good-fg)", fontWeight: 700, marginBottom: 8 }}>{saved} ✓</div>}

      {/* One accordion, the Catalog's shape: System first, then a band per
          system category. An open band shows every module type inside it
          EXPANDED. From 900px up a sticky band list with counts rides on the
          left (the redesign's option B); on a phone the accordion headers
          are the navigation. */}
      <div className="band-shell">
      <nav className="band-side" aria-label="Procedure groups">
        {BANDS.map((band) => {
          const n = band.types.reduce((acc, ty) => acc + rowsIn(band.key, ty).length, 0);
          return (
            <button key={band.key} type="button"
              className={openBand === band.key ? "active" : undefined}
              onClick={() => setOpenBand(openBand === band.key ? null : band.key)}>
              {band.key === "system" ? "System-wide" : band.label}
              <b>{n || ""}</b>
            </button>
          );
        })}
      </nav>
      <div>
      {BANDS.map((band) => {
        const bandRows = band.types.flatMap((ty) => rowsIn(band.key, ty));
        const bandOpen = openBand === band.key;
        const bandRecur = bandRows.filter((i) => i.intervalDays !== null).length;
        return (
        <div key={band.key}>
          <div className="row-hover" onClick={() => setOpenBand(bandOpen ? null : band.key)}
            style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 4px", cursor: "pointer", borderTop: "1px solid var(--line)" }}>
            <span style={{ fontSize: 16, fontWeight: 800, color: "var(--navy)", letterSpacing: "-0.2px" }}>
              {band.key === "system" ? "System-wide" : band.label}
            </span>
            <span className="mut t-small">
              {bandRows.length
                ? `${bandRows.length} procedure${bandRows.length === 1 ? "" : "s"}${bandRecur ? ` · ${bandRecur} maintenance` : ""}`
                : "no procedures yet"}
              {band.key !== "system" && ` · ${band.types.length} type${band.types.length === 1 ? "" : "s"}`}
            </span>
            <span className="mut t-small" style={{ marginLeft: "auto" }}>{bandOpen ? "▴" : "▾"}</span>
          </div>
          {bandOpen && (
            <div style={{ padding: "10px 0 12px" }}>
              {band.subtitle && <div className="mut t-small" style={{ marginBottom: 10 }}>{band.subtitle}</div>}
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
                        <span className="t-body" style={{ fontWeight: 700 }}>{g.label}</span>
                        <span className="mut t-meta">
                          {all.length ? `${all.length} procedure${all.length === 1 ? "" : "s"}` : "none yet"}
                        </span>
                        {/* Filed in the wrong place: move the type, keeping its
                            models and their makers. Only inside a real category. */}
                        {band.key !== "__loose" && (
                          <button className="btn link" disabled={pending}
                            onClick={() => {
                              setMoving({ assetType: g.type, from: band.key });
                              setMoveTo(""); setSaved(""); setError("");
                            }}>move</button>
                        )}
                      </div>
                    )}
                    {all.length > 0 && list.length === 0 && (
                      <div className="mut t-small" style={{ marginBottom: 6 }}>
                        {hidden} hidden by the {FILTERS.find((f) => f.key === filter)?.label} filter.
                      </div>
                    )}
                    <div ref={(el) => { listRefs.current[listKey] = el; }}>
                      {list.map((i) => renderRow(i, g.type, band.key, listKey, list.map((x) => x.id)))}
                    </div>
                    {list.length > 0 && hidden > 0 && (
                      <div className="mut t-meta" style={{ marginBottom: 6 }}>
                        +{hidden} more hidden by the filter.
                      </div>
                    )}
                    <button className="btn sm" onClick={() => openAdd(g.type, band.key)}
                      style={{ width: "100%", border: "1px dashed var(--sky)", background: "#F7FBFE", color: "var(--t-info-fg)" }}>
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
      </div>
      </div>

      <Legend items={[
        { tone: "bad", label: "required before sign-off" },
        { tone: "good", label: "maintenance" },
        { tone: "info", label: "at intake" },
        { tone: "neutral", label: "on demand" },
      ]} />

      {sheet && (
        <ProcedureDialog
          sheet={sheet} items={items} modelOptions={modelOptions}
          modelsByCategory={modelsByCategory} categories={categories}
          categoriesByType={categoriesByType} focus={focus}
          onClose={() => setSheet(null)}
          onSaved={(name, id, extra) => {
            setSheet(null);
            if (id) setFlashId(id);
            setSaved(`Saved "${name}"${extra}`);
            setTimeout(() => setSaved(""), 4000);
          }} />
      )}
    </div>
  );
}
