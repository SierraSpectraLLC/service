"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { addCheckoutItem, updateCheckoutItem, deleteCheckoutItem, reorderCheckoutItems } from "@/app/actions";
import { summarizeItem, impactLine, RESULT_TYPES, RESULT_LABEL, type CheckoutItem } from "@/lib/checkout";

type Item = CheckoutItem & { id: number };

const KIND_GLYPH: Record<string, { glyph: string; bg: string; fg: string }> = {
  task: { glyph: "☐", bg: "#E7F2FA", fg: "#1D6396" },
  test: { glyph: "◎", bg: "#EDEBFA", fg: "#4F45A3" },
};

const emptyDraft = {
  kind: "test", name: "", resultType: "pass_fail", target: "", tolerancePct: "",
  requiresNote: false, consumesPart: false, modelScope: [] as string[],
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
          placeholder={options.length ? "Type to filter models..." : "No models in the catalog yet"}
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

export default function CheckoutItemsPanel({ items, assetTypes, modelOptions }: {
  items: Item[];
  // Asset types are an open vocabulary: starters + types in use anywhere.
  // A brand-new category lives here (client state) until its first item saves.
  assetTypes: string[];
  modelOptions: Record<string, string[]>; // distinct catalog models per asset type
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [customTypes, setCustomTypes] = useState<string[]>([]);
  const [addingCat, setAddingCat] = useState(false);
  const [newCat, setNewCat] = useState("");

  // System first - instrument-level items run once per system, not per asset.
  const GROUPS: { type: string; label: string; subtitle?: string }[] = [
    { type: "system", label: "System", subtitle: "Runs once per instrument, not per asset." },
    ...[...new Set([...assetTypes, ...items.map((i) => i.assetType), ...customTypes])]
      .filter((t) => t && t !== "system")
      .map((k) => ({ type: k, label: k })),
  ];

  const addCategory = () => {
    const name = newCat.trim().slice(0, 40);
    if (!name || GROUPS.some((g) => g.type.toLowerCase() === name.toLowerCase())) { setNewCat(""); setAddingCat(false); return; }
    setCustomTypes((c) => [...c, name]);
    setNewCat("");
    setAddingCat(false);
    setExpanded(name);
  };
  const [sheet, setSheet] = useState<null | { assetType: string; id?: number }>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const [pending, startTransition] = useTransition();
  // Optimistic row order per group while a reorder is in flight.
  const [orderOverride, setOrderOverride] = useState<Record<string, number[]>>({});
  const listRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const drag = useRef<{ type: string; ids: number[]; itemId: number; dirty: boolean } | null>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  const grouped = useMemo(() => {
    const by = new Map<string, Item[]>();
    for (const g of GROUPS) by.set(g.type, []);
    for (const i of items) by.get(i.assetType)?.push(i);
    for (const [type, list] of by) {
      list.sort((a, b) => a.position - b.position || a.id - b.id);
      const order = orderOverride[type];
      if (order) list.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    }
    return by;
    // GROUPS is derived from these:
  }, [items, orderOverride, assetTypes, customTypes]);

  // Sheet lifecycle: escape closes, focus moves in and stays trapped.
  useEffect(() => {
    if (!sheet) return;
    const el = sheetRef.current;
    el?.querySelector<HTMLElement>("input, button, select")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setSheet(null); return; }
      if (e.key !== "Tab" || !el) return;
      const focusables = [...el.querySelectorAll<HTMLElement>("button, input, select, [tabindex]")].filter((f) => !f.hasAttribute("disabled"));
      if (!focusables.length) return;
      const first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sheet]);

  const openAdd = (assetType: string, kind: string) => {
    setDraft({ ...emptyDraft, kind });
    setError("");
    setSheet({ assetType });
  };
  const openEdit = (i: Item) => {
    setDraft({
      kind: i.kind, name: i.name, resultType: i.resultType,
      target: i.target ?? "", tolerancePct: i.tolerancePct ?? "",
      requiresNote: i.requiresNote, consumesPart: i.consumesPart, modelScope: i.modelScope,
    });
    setError("");
    setSheet({ assetType: i.assetType, id: i.id });
  };

  const save = () => {
    if (!sheet || !draft.name.trim()) return;
    setError("");
    const payload = { ...draft, assetType: sheet.assetType,
      modelScope: sheet.assetType === "system" ? [] : draft.modelScope };
    startTransition(async () => {
      const res = sheet.id ? await updateCheckoutItem(sheet.id, payload) : await addCheckoutItem(payload);
      if (res?.error) { setError(res.error); return; }
      setSheet(null);
      setSaved(`Saved "${draft.name.trim()}"`);
      setTimeout(() => setSaved(""), 3000);
    });
  };

  // Pointer-based reorder (works for mouse and touch; the handle has
  // touch-action: none so dragging doesn't scroll the page). The handle
  // captures the pointer, each move re-slots the row optimistically, and
  // pointer-up persists the final order.
  const startDrag = (e: React.PointerEvent, assetType: string, itemId: number) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { type: assetType, ids: (grouped.get(assetType) ?? []).map((i) => i.id), itemId, dirty: false };
  };
  const moveDrag = (e: React.PointerEvent) => {
    const d = drag.current;
    const wrap = d && listRefs.current[d.type];
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
    setOrderOverride((s) => ({ ...s, [d.type]: ids }));
  };
  const endDrag = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.dirty) startTransition(() => reorderCheckoutItems(d.type, d.ids));
  };

  const impact = sheet
    ? impactLine(draft.kind, sheet.assetType, sheet.assetType === "system" ? [] : draft.modelScope,
        (grouped.get(sheet.assetType) ?? []).filter((i) => i.id !== sheet.id))
    : null;

  const renderRow = (i: Item, assetType: string) => {
    const k = KIND_GLYPH[i.kind] ?? KIND_GLYPH.test;
    const scoped = i.modelScope.length > 0;
    return (
      <div key={i.id}
        style={{
          display: "flex", alignItems: "center", gap: 8, padding: "7px 8px",
          border: "1px solid var(--line)", borderRadius: 8, marginBottom: 6, background: "#fff",
          boxShadow: scoped ? "inset 3px 0 0 #6B4FA0" : "none",
          ...(scoped ? { background: "#FBFAFE" } : {}),
        }}>
        <span className="drag-handle mut" aria-label="Drag to reorder" tabIndex={0}
          onPointerDown={(e) => startDrag(e, assetType, i.id)} onPointerMove={moveDrag}
          onPointerUp={endDrag} onPointerCancel={endDrag}
          style={{ fontSize: 13, userSelect: "none", padding: "2px 2px" }}>⠿</span>
        <span aria-hidden style={{ width: 20, height: 20, borderRadius: 5, background: k.bg, color: k.fg, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 12, flexShrink: 0 }}>
          {k.glyph}
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 700 }}>{i.name}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 2, alignItems: "center" }}>
            <span className="mono" style={{ fontSize: 11, color: "var(--slate)", background: "#F1F4F8", borderRadius: 4, padding: "1px 5px" }}>
              {summarizeItem(i)}
            </span>
            {scoped ? (
              <>
                {i.modelScope.slice(0, 2).map((m) => (
                  <span key={m} className="pill" style={{ background: "#EDEBFA", color: "#4F45A3" }}>{m}</span>
                ))}
                {i.modelScope.length > 2 && (
                  <span className="pill" style={{ background: "#EDEBFA", color: "#4F45A3" }}>+{i.modelScope.length - 2}</span>
                )}
              </>
            ) : (
              <span className="pill" style={{ background: "#EEF1F5", color: "#94A3B8" }}>All models</span>
            )}
          </div>
        </div>
        <button className="btn link" aria-label={`Edit ${i.name}`} title="Edit" disabled={pending}
          onClick={() => openEdit(i)} style={{ fontSize: 14, padding: 4 }}>✎</button>
        <button className="btn link" aria-label={`Remove ${i.name}`} title="Remove" disabled={pending}
          onClick={() => { if (window.confirm(`Remove "${i.name}"? Items already generated on systems stay.`)) startTransition(() => deleteCheckoutItem(i.id)); }}
          style={{ fontSize: 14, padding: 4, color: "#A32D2D" }}>×</button>
      </div>
    );
  };

  return (
    <div className="card">
      <div className="card-title" style={{ marginBottom: 2 }}>Checkout</div>
      <div className="mut" style={{ fontSize: 12, marginBottom: 8 }}>
        Tasks and tests created automatically when a system or asset is added.
      </div>
      <details style={{ marginBottom: 12 }}>
        <summary style={{ fontSize: 12, fontWeight: 700, color: "#1D6396", cursor: "pointer" }}>How these get applied</summary>
        <ul className="mut" style={{ fontSize: 12, margin: "6px 0 0", paddingLeft: 18 }}>
          <li>Adding or installing an asset creates its type&apos;s items; creating a system creates the System items once.</li>
          <li>A task is just done / not done; a test records a result (pass/fail, a measured value, a reading, or a note).</li>
          <li>When any model-specific item matches, it replaces the all-model items of the same kind - tasks and tests never replace each other.</li>
        </ul>
      </details>
      {saved && <div style={{ fontSize: 12, color: "#2E6B2E", fontWeight: 700, marginBottom: 8 }}>{saved} ✓</div>}

      {GROUPS.map((g) => {
        const list = grouped.get(g.type) ?? [];
        const open = expanded === g.type;
        const tasks = list.filter((i) => i.kind === "task").length;
        const tests = list.length - tasks;
        const scopedCount = list.filter((i) => i.modelScope.length > 0).length;
        const counts = list.length
          ? [tasks ? `${tasks} task${tasks === 1 ? "" : "s"}` : "", tests ? `${tests} test${tests === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ")
          : "none yet";
        return (
          <div key={g.type} style={{ border: "1px solid var(--line)", borderRadius: 10, marginBottom: 8, overflow: "hidden" }}>
            <div className="row-hover" onClick={() => setExpanded(open ? null : g.type)}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>{g.label}</span>
                {g.subtitle && <span className="mut" style={{ fontSize: 11, marginLeft: 8 }}>{g.subtitle}</span>}
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="mut" style={{ fontSize: 12 }}>{counts}</div>
                {scopedCount > 0 && <div style={{ fontSize: 11, color: "#6B4FA0" }}>{scopedCount} model-specific</div>}
              </div>
              <span className="mut" style={{ fontSize: 12 }}>{open ? "▾" : "▸"}</span>
            </div>

            {open && (
              <div style={{ borderTop: "1px solid var(--line)", padding: 12, background: "#FAFBFD" }}>
                {list.length === 0 && (
                  <div className="mut" style={{ fontSize: 13, marginBottom: 8 }}>Nothing is created for this type yet.</div>
                )}
                <div ref={(el) => { listRefs.current[g.type] = el; }}>
                  {list.map((i) => renderRow(i, g.type))}
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: list.length ? 8 : 0 }}>
                  <button className="btn sm" onClick={() => openAdd(g.type, "task")}
                    style={{ flex: 1, border: "1px dashed var(--sky)", background: "#F7FBFE", color: "#1D6396" }}>＋ Task</button>
                  <button className="btn sm" onClick={() => openAdd(g.type, "test")}
                    style={{ flex: 1, border: "1px dashed var(--sky)", background: "#F7FBFE", color: "#1D6396" }}>＋ Test</button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {addingCat ? (
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4 }}>
          <input autoFocus value={newCat} onChange={(e) => setNewCat(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") addCategory(); if (e.key === "Escape") { setAddingCat(false); setNewCat(""); } }}
            placeholder='New category, e.g. "N2 generator"' style={{ flex: "1 1 200px", maxWidth: 280, fontSize: 13 }} />
          <button className="btn sm accent" onClick={addCategory} disabled={!newCat.trim()}>Add</button>
          <button className="btn link" onClick={() => { setAddingCat(false); setNewCat(""); }}>cancel</button>
        </div>
      ) : (
        <button className="btn sm" onClick={() => setAddingCat(true)}
          style={{ width: "100%", border: "1px dashed var(--sky)", background: "#F7FBFE", color: "#1D6396", marginTop: 4 }}>
          ＋ New category
        </button>
      )}
      <div className="mut" style={{ fontSize: 11, marginTop: 6 }}>
        A category matches assets of that type by name - give an asset the type &quot;N2 generator&quot; and its
        items are created when one is added. New categories stick once their first item is saved.
      </div>

      {sheet && (
        <>
          <div className="scrim" onClick={() => setSheet(null)} />
          <div className="sheet" ref={sheetRef} role="dialog" aria-modal="true"
            aria-label={`${sheet.id ? "Edit" : "New"} checkout item`}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--navy)" }}>
                {sheet.id ? "Edit" : "New"} · {sheet.assetType === "system" ? "System" : sheet.assetType}
              </div>
              <div className="seg" role="group" aria-label="Item type" style={{ marginLeft: "auto" }}>
                {(["task", "test"] as const).map((k) => (
                  <button key={k} type="button" aria-pressed={draft.kind === k} onClick={() => setDraft({ ...draft, kind: k })}>
                    {k === "task" ? "☐ Task" : "◎ Test"}
                  </button>
                ))}
              </div>
            </div>

            <label>Name *</label>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              onKeyDown={(e) => { if (e.key === "Enter") save(); }}
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
              <div style={{ display: "flex", gap: 16, marginBottom: 10, flexWrap: "wrap" }}>
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
            )}

            {sheet.assetType === "system" ? (
              <div className="mut" style={{ fontSize: 12 }}>
                System items are created with every new system. Model-specific work belongs on the
                asset types below, where the models live.
              </div>
            ) : (
              <>
                <label>Models</label>
                <ScopeField scope={draft.modelScope} options={modelOptions[sheet.assetType] ?? []}
                  onChange={(next) => setDraft({ ...draft, modelScope: next })} />
              </>
            )}

            {impact && (
              <div style={{
                fontSize: 12, marginTop: 10, padding: "7px 10px", borderRadius: 8,
                background: impact.warning ? "#FAF0DC" : "#F1F4F8",
                color: impact.warning ? "#8A5410" : "var(--slate)",
                fontWeight: impact.warning ? 700 : 400,
              }}>
                {impact.text}
              </div>
            )}
            {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{error}</div>}

            <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
              <button className="btn sm" onClick={() => setSheet(null)} disabled={pending}>Cancel</button>
              <button className="btn sm accent" onClick={save} disabled={pending || !draft.name.trim()}>
                {pending ? "Saving..." : "Save item"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
