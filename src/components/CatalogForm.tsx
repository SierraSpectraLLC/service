"use client";

import { useState, useTransition } from "react";
import { addVocabTerm, addVocabTerms, deleteVocabTerm, setVocabCategories, setVocabManufacturer } from "@/app/actions";
import CatalogGrid from "./CatalogGrid";
import { CardGrid, EntityCard, FacetStrip, PageHead, Pager, Panel, Pill, RowActions, Toolbar } from "@/components/ui";
import { pageOf } from "@/lib/paging";
import { stockSrc } from "@/lib/photos";
import Dialog, { DialogStatus } from "@/components/ui/Dialog";
import { confirmDialog, inputDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";

/** How many cards a page draws. Twelve rows at the grid's widest, four at its
    narrowest - enough to scan, short enough to reach the bottom of. */
const PAGE_SIZE = 48;

type Model = { id: number; assetType: string; name: string; categories: string[]; manufacturer: string; inUse: number; hasPhoto: boolean };
type Category = { id: number | null; name: string; systems: number };
type AssetType = { id: number | null; name: string; models: number; inUse: number };

/* Sentinel key for the untagged section, as an ESCAPE rather than a literal
   NUL: the same string either way, but a NUL byte in the source makes git
   call this whole file binary, so every diff to this component stopped
   rendering in review and grep skipped it. A leading NUL is still what
   makes it uncollidable with a category somebody typed. */
const UNIVERSAL = "\u0000any";

/**
 * The equipment catalog: system categories, and the models that make each one
 * up, grouped by asset type. One section per category is the point - a GC-MS
 * section listing FID and TCD next to an LC-MS section listing SPD-20A reads
 * the way an engineer thinks, where one flat "Detector" list does not.
 */
export default function CatalogForm({ categories, models, types, makers }: {
  categories: Category[];
  models: Model[];
  types: AssetType[];
  /** The maker/vendor book (defined ∪ in use) - the datalist every maker input reads. */
  makers: string[];
}) {
  // Which facet the grid is filtered to: "all", a category name, the
  // untagged sentinel, or "nomaker". Replaces the per-category sections.
  const [facet, setFacet] = useState<string>("all");
  const [q, setQ] = useState("");
  /*
   * A page of the grid. 1,118 models drawn as cards made a page nobody could
   * reach the bottom of - the shop's words were "astronomically long" - and
   * the list is already in memory, so what had to shrink was the DOM, not the
   * query.
   *
   * Reset by every filter change below, because landing on page 12 of a search
   * that just started is not what anybody meant. pageOf clamps as well, which
   * covers the paths that forget.
   */
  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState<Record<string, { assetType: string; name: string; manufacturer: string }>>({});
  const [catDraft, setCatDraft] = useState("");
  const [typeDraft, setTypeDraft] = useState("");
  const [error, setError] = useState("");
  const [typeError, setTypeError] = useState("");
  const [grid, setGrid] = useState<string | null>(null); // which section's grid is open
  const [modelDialog, setModelDialog] = useState(false);
  const [justAdded, setJustAdded] = useState(""); // last model saved while the dialog stayed open
  const [pending, startTransition] = useTransition();
  const assetTypes = types.map((t) => t.name);

  /* One door for both filters, so neither can change without the page going
     back to the top. Two setStates at each call site is the version of this
     that works until somebody adds a third filter. */
  const filterTo = (next: { facet?: string; q?: string }) => {
    if (next.facet !== undefined) setFacet(next.facet);
    if (next.q !== undefined) setQ(next.q);
    setPage(1);
  };


  /**
   * One name per line, or comma-separated - so a list pasted out of a document
   * or a spreadsheet column becomes N terms instead of one term with commas in
   * its name. A single name still just works.
   */
  const splitNames = (raw: string) =>
    raw.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

  const addMany = (kind: "category" | "asset_type", raw: string, onOk: () => void, setErr: (m: string) => void) => {
    const names = splitNames(raw);
    if (!names.length) return;
    setErr("");
    startTransition(async () => {
      const res = await addVocabTerms(names.map((name) => ({ kind, assetType: "", name })));
      if (res?.error) { setErr(res.error); return; }
      // Duplicates in a pasted list are expected, not an error worth stopping
      // on - report them and keep whatever was new.
      if (res.failures?.length) setErr(res.failures.map((f) => `${f.name}: ${f.error}`).join("; "));
      if (res.created) onOk();
    });
  };

  const catNames = categories.map((c) => c.name);
  const draftFor = (key: string) => draft[key] ?? { assetType: assetTypes[0] ?? "Pump", name: "", manufacturer: "" };

  const addModel = () => {
    const key = draftKey;
    const d = draftFor(key);
    if (!d.name.trim()) return;
    setError("");
    startTransition(async () => {
      const res = await addVocabTerm("model", d.assetType, d.name, activeCategory ? [activeCategory] : [], d.manufacturer);
      if (res?.error) setError(res.error);
      // The maker sticks: entering ten Shimadzu pumps shouldn't mean typing it ten times.
      else {
        setJustAdded(d.name.trim());
        // The dialog stays open so ten pumps are ten names, not ten trips - so
        // the toast is the only thing that says the save landed.
        toast({ message: `Added ${d.name.trim()} to the catalog${activeCategory ? ` under ${activeCategory}` : ""}` });
        setDraft((m) => ({ ...m, [key]: { assetType: d.assetType, name: "", manufacturer: d.manufacturer } }));
      }
    });
  };

  const addCategory = () => addMany("category", catDraft, () => {
    filterTo({ facet: splitNames(catDraft)[0] ?? "all" });
    setCatDraft("");
  }, setError);

  /** Untag a model from one category; the last tag removed makes it universal. */
  const untag = (m: Model, categoryName: string) =>
    startTransition(async () => {
      const res = await setVocabCategories(m.id, m.categories.filter((c) => c !== categoryName));
      if (res?.error) setError(res.error);
    });

  const removeModel = (m: Model) =>
    startTransition(async () => { await deleteVocabTerm(m.id); });

  /** One category's models, or the untagged ones when `name` is null. */
  const modelsIn = (name: string | null) =>
    name === null
      ? models.filter((m) => m.categories.length === 0)
      : models.filter((m) => m.categories.includes(name));

  const activeCategory = catNames.includes(facet) ? facet : null;
  /**
   * Which draft slot the add-model dialog reads and writes.
   *
   * It is keyed on the CATEGORY the model would be filed under, not on the
   * facet - because "all" and "nomaker" are views, not categories, and both
   * file a new model exactly where the untagged sentinel does. Keying the
   * dialog's inputs on the facet while the save read the sentinel meant that
   * from either of those two views the save found an empty draft, bailed on
   * its own blank-name guard, and the button did nothing at all.
   */
  const draftKey = activeCategory ?? UNIVERSAL;
  const needle = q.trim().toLowerCase();
  const shownModels = (
    facet === "all" ? models
    : facet === "nomaker" ? models.filter((m) => !m.manufacturer)
    : modelsIn(activeCategory)
  ).filter((m) => !needle || `${m.name} ${m.manufacturer} ${m.assetType} ${m.categories.join(" ")}`.toLowerCase().includes(needle))
    .slice()
    .sort((a, b) => (a.manufacturer || "~").localeCompare(b.manufacturer || "~") || a.name.localeCompare(b.name));

  /* What is drawn. shownModels stays the whole filtered set, and everything
     that counts or acts on "what is listed" keeps reading it - a bulk action
     that quietly meant "this page" would be a different action wearing the
     same words. */
  const shown = pageOf(shownModels, page, PAGE_SIZE);

  /** Shared models get untagged from the open category; ones that live only
      here are removed outright, with the fleet consequence spelled out. */
  const makerFlow = async (m: Model) => {
    const next = await inputDialog({
      title: `Who makes ${m.name}?`, action: "Save maker", label: "Manufacturer",
      initial: m.manufacturer, allowEmpty: true,
      hint: "Blank files it under Maker not set.",
    });
    if (next === null || next === m.manufacturer) return;
    startTransition(async () => {
      const res = await setVocabManufacturer(m.id, next);
      if (res?.error) { setError(res.error); return; }
      toast({ message: next ? `${m.name} is made by ${next}` : `Cleared the maker on ${m.name}` });
    });
  };

  const removeFlow = async (m: Model) => {
    if (activeCategory && m.categories.length > 1) { untag(m, activeCategory); return; }
    if (!(await confirmDialog({
      title: `Remove "${m.name}" from the catalog?`,
      body: m.inUse
        ? `${m.inUse} unit${m.inUse === 1 ? "" : "s"} already recorded as this model keep it.`
        : undefined,
      action: `Remove ${m.name}`, tone: "bad",
    }))) return;
    removeModel(m);
    toast({ message: `Removed ${m.name} from the catalog` });
  };

  // The book plus anything on models it hasn't caught up with yet.
  const knownMakers = [...new Set([...makers, ...models.map((m) => m.manufacturer)].filter(Boolean))].sort();

  // The add-model dialog's live footer line: same draft the inline flow used.
  const modelDraft = draftFor(draftKey);
  const modelProblem = modelDraft.name.trim() ? null : "name the model";
  const modelOk = [
    justAdded ? `Added ${justAdded}` : null,
    !modelDraft.manufacturer.trim() ? "No maker set - it lands in the Maker-not-set facet" : null,
  ].filter(Boolean).join(". ") || undefined;

  return (
    <>
      {/* Shared suggestions so "Shimadzu" doesn't become three spellings. */}
      <datalist id="catalog-makers">
        {knownMakers.map((m) => <option key={m} value={m} />)}
      </datalist>
      <PageHead title="Equipment catalog"
        sub="System categories and their models." />

      {/* The catalog at a glance, before any filtering. */}
      <div className="metric-grid" style={{ marginBottom: 12 }}>
        {([
          ["Models", models.length],
          ["In the fleet", models.reduce((n, m) => n + m.inUse, 0)],
          ["System types", categories.length],
          ["Module types", types.length],
          ["Maker not set", models.filter((m) => !m.manufacturer).length],
        ] as [string, number][]).map(([label, n]) => (
          <div key={label} className="card" style={{ padding: "12px 14px", marginBottom: 0 }}>
            <div className="mut t-small">{label}</div>
            <div style={{ fontSize: 26, fontWeight: 700, color: "var(--navy)" }}>{n}</div>
          </div>
        ))}
      </div>

      <Toolbar
        search={
          <input value={q} onChange={(e) => filterTo({ q: e.target.value })}
            placeholder="Model, maker or type" aria-label="Search the catalog" />
        }
        /* Beside the search box, not in a card under the grid. Adding a model
           is what this page is FOR, and it used to be the one thing you had to
           scroll seventy cards past to reach. One flex item so the pair moves
           together when the row wraps. */
        lead={
          <div style={{ display: "flex", gap: 6 }}>
            <button className="btn sm primary" onClick={() => { setError(""); setJustAdded(""); setModelDialog(true); }}>
              + New model
            </button>
            <button className="btn sm" onClick={() => setGrid(grid === facet ? null : facet)}>
              {grid === facet ? "Close grid" : "+ Several"}
            </button>
          </div>
        }
        facets={
          <FacetStrip
            facets={[
              { key: "all", label: "All", count: models.length, on: facet === "all" },
              ...categories.map((c) => ({
                key: c.name, label: c.name,
                count: modelsIn(c.name).length || undefined,
                on: facet === c.name,
              })),
              { key: UNIVERSAL, label: "Any system type", count: modelsIn(null).length || undefined, on: facet === UNIVERSAL },
              { key: "nomaker", label: "Maker not set", count: models.filter((m) => !m.manufacturer).length || undefined, on: facet === "nomaker" },
            ]}
            onToggle={(k) => filterTo({ facet: facet === k ? "all" : k })}
          />
        }
      />

      {/* Errors from the row menus (maker, untag, remove) and from the bulk
          maker set. They used to live in the card at the bottom, which is now
          gone; the dialog carries its own through DialogStatus. */}
      {error && !modelDialog && (
        <div className="t-small" style={{ color: "var(--t-bad-fg)", marginBottom: 10 }}>{error}</div>
      )}

      {/* Unfolded where the button that opens it is. Opening a spreadsheet at
          the far end of a long card grid is a button that appears to do
          nothing. */}
      {grid === facet && (
        <Panel title="Add several models"
          hint={activeCategory
            ? `Filed under ${activeCategory} unless a row says otherwise.`
            : "Left untagged - offered under every system type - unless a row names one."}>
          <CatalogGrid assetTypes={assetTypes} categoryNames={catNames} knownMakers={knownMakers}
            defaultCategory={activeCategory ?? ""} onDone={() => setGrid(null)} />
        </Panel>
      )}

      {/* One page of them. Everything else on this screen - the counts, the
          facets, the bulk maker action below - still speaks for the WHOLE
          filtered set; this is the only thing that is a page. */}
      <Pager page={shown} onPage={setPage} noun="models" label="catalog models" />
      <CardGrid>
        {shown.rows.map((m) => (
          <EntityCard key={m.id} mono
            image={m.hasPhoto ? stockSrc(m.id) : undefined}
            imageAlt={m.name}
            eyebrow={m.manufacturer || <span style={{ fontStyle: "italic" }}>maker not set</span>}
            title={m.name}
            href={`/catalog/${m.id}`}
            meta={`${m.assetType}${m.categories.length ? ` · ${m.categories.join(", ")}` : " · any system type"}`}
            pills={<Pill tone={m.inUse ? "info" : "faint"}>{m.inUse ? `${m.inUse} in fleet` : "unused"}</Pill>}
            kebab={
              <RowActions inline={0} menuLabel={`Actions for ${m.name}`} items={[
                { label: m.manufacturer ? "Change maker" : "Set maker", onClick: () => { void makerFlow(m); } },
                ...(activeCategory && m.categories.length > 1
                  ? [{ label: `Untag from ${activeCategory}`, onClick: () => untag(m, activeCategory) }]
                  : []),
                { label: "Remove", tone: "bad" as const, onClick: () => { void removeFlow(m); } },
              ]} />
            }
          />
        ))}
      </CardGrid>
      {/* Repeated under the grid: on a full page the top one has scrolled well
          out of sight by the time somebody wants the next. */}
      {shown.rows.length > 0 && (
        <Pager page={shown} onPage={setPage} noun="models" label="catalog models" />
      )}
      {shownModels.length === 0 && (
        <div className="empty" style={{ marginBottom: 12 }}>
          <b>{q || facet !== "all" ? "No models match" : "No models yet"}</b>
          Add the first one above - it lands under {activeCategory ?? "whichever category you pick"}.
        </div>
      )}
      {facet === "nomaker" && shownModels.length > 0 && (
        <div style={{ margin: "0 0 12px" }}>
          <button className="btn sm" disabled={pending}
            onClick={async () => {
              const next = await inputDialog({
                title: "Set maker for all shown", action: "Set maker",
                label: "Manufacturer",
                /* "listed" used to be unambiguous because the list was all of
                   them. It is a page now, so the sentence names the number and
                   says the page is not the limit. */
                hint: `Applied to all ${shownModels.length} models this filter matches, not just the page you can see.`,
              });
              if (next === null || !next) return;
              startTransition(async () => {
                for (const m of shownModels) {
                  const res = await setVocabManufacturer(m.id, next);
                  if (res?.error) { setError(res.error); return; }
                }
                toast({ message: `Set the maker on ${shownModels.length} model${shownModels.length === 1 ? "" : "s"}` });
              });
            }}>Set maker for all shown</button>
        </div>
      )}

      {modelDialog && (
        <Dialog open onClose={() => { setModelDialog(false); setJustAdded(""); }} size="sm" title="New model"
          context={activeCategory
            ? `Files under ${activeCategory}`
            : "Filed under no system type - offered everywhere"}
          footer={
            <>
              <DialogStatus error={error} problem={modelProblem} ok={modelOk} />
              <button className="btn" onClick={() => { setModelDialog(false); setJustAdded(""); }} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={() => addModel()} disabled={pending || !!modelProblem}>
                {modelDraft.name.trim() ? `Add ${modelDraft.name.trim()}` : "Add model"}
              </button>
            </>
          }>
          <div className="dialog-section">What it is</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 8 }}>
            <div>
              <label>Module type</label>
              <select value={modelDraft.assetType} disabled={pending} aria-label="Module type"
                onChange={(e) => setDraft((m) => ({ ...m, [draftKey]: { ...draftFor(draftKey), assetType: e.target.value } }))}
                className="t-body" style={{ width: "auto" }}>
                {assetTypes.map((t) => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div style={{ flex: "1 1 140px" }}>
              <label>Model name *</label>
              <input value={modelDraft.name} autoFocus aria-label="Model name"
                onChange={(e) => setDraft((m) => ({ ...m, [draftKey]: { ...draftFor(draftKey), name: e.target.value } }))}
                onKeyDown={(e) => { if (e.key === "Enter") addModel(); }}
                placeholder='e.g. "LC-20ADXR"' className="t-body" />
            </div>
          </div>
          <div className="dialog-section">Who makes it</div>
          <label>Manufacturer</label>
          <input value={modelDraft.manufacturer} list="catalog-makers" aria-label="Manufacturer"
            onChange={(e) => setDraft((m) => ({ ...m, [draftKey]: { ...draftFor(draftKey), manufacturer: e.target.value } }))}
            onKeyDown={(e) => { if (e.key === "Enter") addModel(); }}
            placeholder="Maker" className="t-body" style={{ marginBottom: 8 }} />
        </Dialog>
      )}

      <Panel title="System types" count={categories.length}>
        {categories.map((c) => (
          <div key={c.name} style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "5px 0", borderTop: "1px solid var(--line)" }}>
            <span className="t-body" style={{ fontWeight: 700 }}>{c.name}</span>
            <span className="mut t-meta">
              {modelsIn(c.name).length} model{modelsIn(c.name).length === 1 ? "" : "s"}
              {c.systems ? ` · ${c.systems} system${c.systems === 1 ? "" : "s"}` : ""}
            </span>
            <button className="btn link" style={{ color: "var(--t-bad-fg)", marginLeft: "auto" }} disabled={pending || c.id === null}
              title={c.id === null ? "In use by systems but not defined in the catalog - add it to manage it" : undefined}
              onClick={async () => {
                if (c.id === null) return;
                if (!(await confirmDialog({
                  title: `Remove the "${c.name}" category?`,
                  body: c.systems
                    ? `${c.systems} system${c.systems === 1 ? "" : "s"} using it keep it, and its models stay in the catalog.`
                    : "Its models stay in the catalog.",
                  action: `Remove ${c.name}`, tone: "bad",
                }))) return;
                startTransition(async () => {
                  await deleteVocabTerm(c.id!);
                  toast({ message: `Removed the ${c.name} category` });
                });
              }}>remove</button>
          </div>
        ))}
        <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
          <textarea value={catDraft} onChange={(e) => setCatDraft(e.target.value)} rows={catDraft.includes("\n") ? 4 : 1}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) addCategory(); }}
            placeholder='New system types - "GC-MS", or one per line'
            className="t-body" style={{ flex: "1 1 200px", maxWidth: 300, resize: "vertical" }} />
          <button className="btn sm accent" onClick={addCategory} disabled={pending || !catDraft.trim()}>
            {splitNames(catDraft).length > 1 ? `Add ${splitNames(catDraft).length} types` : "Add system type"}
          </button>
        </div>
        {catNames.length === 0 && (
          <div className="mut t-small" style={{ marginTop: 6 }}>
            No system types defined yet. Add one - LC-MS, GC-MS - and its models nest under it.
          </div>
        )}
      </Panel>

      <Panel title="Module types" count={types.length}>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 8 }}>
          {types.map((t) => (
            <span key={t.name} className="pill info" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
              title={`${t.models} model${t.models === 1 ? "" : "s"} · ${t.inUse} unit${t.inUse === 1 ? "" : "s"} in the fleet`}>
              {t.name}
              {(t.models > 0 || t.inUse > 0) && <span style={{ opacity: 0.6, fontSize: 10 }}>·{t.models || t.inUse}</span>}
              <button type="button" aria-label={`Remove ${t.name}`} disabled={pending || t.id === null}
                title={t.id === null ? "In use by units but not defined in the catalog" : undefined}
                onClick={async () => {
                  if (t.id === null) return;
                  if (!(await confirmDialog({
                    title: `Remove the "${t.name}" type?`,
                    body: t.inUse
                      ? `${t.inUse} unit${t.inUse === 1 ? "" : "s"} recorded as it keep it, but it disappears from the pickers.`
                      : undefined,
                    action: `Remove ${t.name}`, tone: "bad",
                  }))) return;
                  setTypeError("");
                  startTransition(async () => {
                    const res = await deleteVocabTerm(t.id!);
                    if (res?.error) setTypeError(res.error);
                    else toast({ message: `Removed the ${t.name} type` });
                  });
                }}
                className="t-small" style={{ border: "none", background: "none", color: "inherit", cursor: "pointer", padding: 0, lineHeight: 1 }}>×</button>
            </span>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <textarea value={typeDraft} onChange={(e) => setTypeDraft(e.target.value)} rows={typeDraft.includes("\n") ? 4 : 1}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) addMany("asset_type", typeDraft, () => setTypeDraft(""), setTypeError); }}
            placeholder='New module types - "N2 generator", or one per line'
            className="t-body" style={{ flex: "1 1 200px", maxWidth: 300, resize: "vertical" }} />
          <button className="btn sm accent" disabled={pending || !typeDraft.trim()}
            onClick={() => addMany("asset_type", typeDraft, () => setTypeDraft(""), setTypeError)}>
            {splitNames(typeDraft).length > 1 ? `Add ${splitNames(typeDraft).length} types` : "Add type"}
          </button>
        </div>
        {typeError && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{typeError}</div>}
      </Panel>
    </>
  );
}
