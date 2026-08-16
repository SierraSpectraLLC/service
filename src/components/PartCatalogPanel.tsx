"use client";

import { useMemo, useState, useTransition } from "react";
import { addCatalogPart, archiveCatalogPart, setKitLines, updateCatalogPart } from "@/app/actions";
import {
  catalogLabel, kitContents, PART_KINDS, PART_KIND_LABEL, searchCatalog,
} from "@/lib/partCatalog";

export type CatalogRow = {
  id: number; partNumber: string; name: string; manufacturer: string; mfrPartNumber: string;
  kind: string; assetTypes: string[]; models: string[]; note: string; archived: boolean;
  lines: { partNumber: string; name: string; qty: number }[];
};

const KIND_COLOR: Record<string, { bg: string; fg: string }> = {
  part: { bg: "#E7F2FA", fg: "#1D6396" },
  consumable: { bg: "#FAF0DC", fg: "#8A5410" },
  kit: { bg: "#EDEBFA", fg: "#4F45A3" },
};

/** {bg,fg} is how this codebase names a chip's palette; CSS wants other words. */
const pill = (c: { bg: string; fg: string }) => ({ background: c.bg, color: c.fg });

const emptyDraft = {
  partNumber: "", name: "", manufacturer: "", mfrPartNumber: "",
  kind: "part", assetTypes: [] as string[], models: [] as string[], note: "",
};

/**
 * The shop's own parts book: what each number IS.
 *
 * The list on the right of this panel is the one that makes a catalog actually
 * get filled in - the numbers already used on real work that nothing has ever
 * described. Asking somebody to type out their parts book from scratch is how a
 * catalog stays empty; asking them to name the twelve numbers they used last
 * month is a job somebody finishes.
 */
export default function PartCatalogPanel({ items, assetTypes, modelsByType, unnamed }: {
  items: CatalogRow[];
  assetTypes: string[];
  /** Catalog models per module type, for the per-model chips. */
  modelsByType: Record<string, string[]>;
  /** Part numbers in use on real work that the catalog has never heard of. */
  unnamed: string[];
}) {
  const [query, setQuery] = useState("");
  const [sheet, setSheet] = useState<null | { id?: number }>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [lines, setLines] = useState<{ partNumber: string; name: string; qty: number }[]>([]);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const shown = useMemo(() => searchCatalog(items, query, 200), [items, query]);

  const openAdd = (partNumber = "") => {
    setDraft({ ...emptyDraft, partNumber });
    setLines([]); setError(""); setSheet({});
  };
  const openEdit = (r: CatalogRow) => {
    setDraft({
      partNumber: r.partNumber, name: r.name, manufacturer: r.manufacturer,
      mfrPartNumber: r.mfrPartNumber, kind: r.kind, assetTypes: r.assetTypes,
      models: r.models, note: r.note,
    });
    setLines(r.lines.map((l) => ({ ...l })));
    setError(""); setSheet({ id: r.id });
  };

  const save = () => {
    if (!draft.partNumber.trim()) { setError("A part number is the one thing this needs"); return; }
    setError("");
    startTransition(async () => {
      let id = sheet?.id;
      if (id === undefined) {
        const res = await addCatalogPart(draft);
        if (res.error) { setError(res.error); return; }
        id = res.id;
      } else {
        const res = await updateCatalogPart(id, draft);
        if (res.error) { setError(res.error); return; }
      }
      // Contents are a second write, and only for a kit - the parts that are
      // not kits have none and saving an empty list every time would churn.
      if (id !== undefined && draft.kind === "kit") {
        const r2 = await setKitLines(id, lines);
        if (r2?.error) { setError(r2.error); return; }
      }
      setSheet(null);
    });
  };

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <div className="card-title">Parts book</div>
        <span className="mut" style={{ fontSize: 11 }}>
          {items.length} number{items.length === 1 ? "" : "s"}
        </span>
        <button className="btn sm primary" style={{ marginLeft: "auto" }} onClick={() => openAdd()}>
          ＋ Part number
        </button>
      </div>
      <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
        What each number means, so a part fitted in March still has a name in December.
        Nothing here is required to record a part - an unknown number always works.
      </div>

      <input value={query} onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by your number, theirs, a name or a maker"
        style={{ marginBottom: 10, fontSize: 13 }} />

      {shown.map((r) => (
        <div key={r.id} style={{
          display: "flex", alignItems: "center", gap: 8, padding: "7px 8px",
          border: "1px solid var(--line)", borderRadius: 8, marginBottom: 6,
          opacity: r.archived ? 0.55 : 1,
        }}>
          <button className="btn link" onClick={() => openEdit(r)}
            style={{ flex: 1, minWidth: 0, textAlign: "left", padding: 0 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
              <span className="mono" style={{ fontWeight: 700, fontSize: 12, color: "var(--navy)" }}>{r.partNumber}</span>
              <span style={{ fontSize: 13 }}>{r.name || <span className="mut">unnamed</span>}</span>
              <span className="pill" style={pill(KIND_COLOR[r.kind] ?? KIND_COLOR.part)}>{PART_KIND_LABEL[r.kind]}</span>
              {r.archived && <span className="pill" style={{ background: "#F4F6F9", color: "#94A3B8" }}>retired</span>}
            </div>
            <div className="mut" style={{ fontSize: 11 }}>
              {[
                r.manufacturer && `${r.manufacturer}${r.mfrPartNumber ? ` ${r.mfrPartNumber}` : ""}`,
                r.kind === "kit" && r.lines.length ? kitContents(r.lines) : "",
                r.assetTypes.length ? r.assetTypes.join(", ") : "",
                r.models.length ? r.models.join(", ") : "",
              ].filter(Boolean).join(" · ")}
            </div>
          </button>
          <button className="btn link" style={{ fontSize: 11 }} disabled={pending}
            onClick={() => startTransition(async () => { await archiveCatalogPart(r.id, !r.archived); })}>
            {r.archived ? "restore" : "retire"}
          </button>
        </div>
      ))}
      {shown.length === 0 && (
        <div className="mut" style={{ fontSize: 13 }}>
          {query ? "Nothing matches that." : "Nothing catalogued yet."}
        </div>
      )}

      {/* The list that makes this tractable: numbers the shop has really used
          that nothing describes. One click each, rather than a blank book. */}
      {unnamed.length > 0 && (
        <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
          <div className="eyebrow" style={{ marginBottom: 4 }}>Used but not described</div>
          <div className="mut" style={{ fontSize: 11, marginBottom: 8 }}>
            {unnamed.length} number{unnamed.length === 1 ? "" : "s"} on real work with nothing to say what they are.
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {unnamed.slice(0, 40).map((pn) => (
              <button key={pn} className="btn sm mono" style={{ fontSize: 11 }} onClick={() => openAdd(pn)}>
                {pn} +
              </button>
            ))}
            {unnamed.length > 40 && (
              <span className="mut" style={{ fontSize: 11, alignSelf: "center" }}>+{unnamed.length - 40} more</span>
            )}
          </div>
        </div>
      )}

      {sheet && (
        <>
          <div className="scrim" onClick={() => setSheet(null)} />
          <div className="sheet" role="dialog" aria-modal="true" aria-label="Catalog entry">
            <div style={{ fontSize: 13, fontWeight: 700, color: "var(--navy)", marginBottom: 10 }}>
              {sheet.id ? "Edit" : "New"} part number
            </div>

            <label>Your number *</label>
            <input className="mono" value={draft.partNumber} autoFocus
              onChange={(e) => setDraft({ ...draft, partNumber: e.target.value })}
              placeholder="AGI-7167-PMK" style={{ marginBottom: 8 }} />

            <label>What it is</label>
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="Agilent 7176 PM Kit" style={{ marginBottom: 8 }} />

            <div className="pf2" style={{ marginBottom: 8 }}>
              <div>
                <label>Manufacturer</label>
                <input value={draft.manufacturer} onChange={(e) => setDraft({ ...draft, manufacturer: e.target.value })}
                  placeholder="Agilent" />
              </div>
              <div>
                <label>Their number</label>
                <input className="mono" value={draft.mfrPartNumber}
                  onChange={(e) => setDraft({ ...draft, mfrPartNumber: e.target.value })}
                  placeholder="G4521-67001" />
              </div>
            </div>

            <label>Kind</label>
            <div className="seg" role="group" aria-label="Kind" style={{ marginBottom: 8 }}>
              {PART_KINDS.map((k) => (
                <button key={k} type="button" aria-pressed={draft.kind === k}
                  onClick={() => setDraft({ ...draft, kind: k })}>{PART_KIND_LABEL[k]}</button>
              ))}
            </div>

            {draft.kind === "kit" && (
              <div style={{ marginBottom: 8 }}>
                <label>What is in it</label>
                <div className="mut" style={{ fontSize: 11, marginBottom: 6 }}>
                  For reading, not for counting. A kit is stocked and issued as one sealed bag -
                  exploding it would have the shelf claim ten septa are loose when they are not.
                </div>
                {lines.map((l, i) => (
                  <div key={i} style={{ display: "flex", gap: 6, marginBottom: 4 }}>
                    <input type="number" min={1} value={l.qty} aria-label="Quantity" style={{ width: 64, fontSize: 12 }}
                      onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, qty: parseInt(e.target.value) || 1 } : x))} />
                    <input className="mono" value={l.partNumber} placeholder="PN" style={{ flex: "0 1 140px", fontSize: 12 }}
                      onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, partNumber: e.target.value } : x))} />
                    <input value={l.name} placeholder="What it is" style={{ flex: 1, fontSize: 12 }}
                      onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                    <button className="btn link" style={{ fontSize: 11 }}
                      onClick={() => setLines(lines.filter((_, j) => j !== i))}>×</button>
                  </div>
                ))}
                <button className="btn sm" onClick={() => setLines([...lines, { partNumber: "", name: "", qty: 1 }])}>
                  ＋ Line
                </button>
              </div>
            )}

            <label>Suits</label>
            <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 8 }}>
              {assetTypes.map((t) => {
                const on = draft.assetTypes.includes(t);
                return (
                  <button key={t} type="button" className={on ? "btn sm accent" : "btn sm"} style={{ fontSize: 11 }}
                    onClick={() => setDraft({
                      ...draft,
                      assetTypes: on ? draft.assetTypes.filter((x) => x !== t) : [...draft.assetTypes, t],
                    })}>
                    {t}
                  </button>
                );
              })}
              {assetTypes.length === 0 && <span className="mut" style={{ fontSize: 11 }}>No module types in the catalog yet.</span>}
            </div>

            {/* The models within those types, when the number is model-specific:
                an LC-20 seal kit is not an LC-30 seal kit. No types picked =
                offer every model. None selected = suits any model. */}
            {(() => {
              const pool = (draft.assetTypes.length ? draft.assetTypes : Object.keys(modelsByType))
                .flatMap((t) => modelsByType[t] ?? []);
              const options = [...new Set(pool)];
              if (options.length === 0) return null;
              return (
                <>
                  <label>Specific models <span className="mut" style={{ fontWeight: 400 }}>(none = any model)</span></label>
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 8 }}>
                    {options.map((m) => {
                      const on = draft.models.includes(m);
                      return (
                        <button key={m} type="button" className={on ? "btn sm primary" : "btn sm"} style={{ fontSize: 11 }}
                          onClick={() => setDraft({
                            ...draft,
                            models: on ? draft.models.filter((x) => x !== m) : [...draft.models, m],
                          })}>
                          {m}
                        </button>
                      );
                    })}
                  </div>
                </>
              );
            })()}

            <label>Note</label>
            <textarea value={draft.note} rows={2} style={{ width: "100%", marginBottom: 8 }}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })} />

            <div className="mut" style={{ fontSize: 12, padding: "6px 10px", borderRadius: 8, background: "#F1F4F8" }}>
              {draft.partNumber.trim()
                ? catalogLabel({ partNumber: draft.partNumber, name: draft.name, manufacturer: draft.manufacturer })
                : "A part number is the one thing this needs."}
            </div>
            {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{error}</div>}

            <div style={{ display: "flex", gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
              <button className="btn sm" onClick={() => setSheet(null)} disabled={pending}>Cancel</button>
              <button className="btn sm accent" onClick={save} disabled={pending || !draft.partNumber.trim()}>
                {pending ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
