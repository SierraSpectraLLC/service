"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import {
  addCatalogPart, addPartPhotos, addPartPrices, archiveCatalogPart, deletePartPrice,
  makePartPhotoCover, removePartPhoto, setKitLines, setPartPhotoCaption, updateCatalogPart,
} from "@/app/actions";
import Dialog from "@/components/ui/Dialog";
import { DataTable, FacetStrip, Id, PageHead, Pill, Toolbar } from "@/components/ui";
import type { DataRow } from "@/components/ui/DataTable";
import { toast } from "@/components/ui/Toast";
import { formatCents } from "@/lib/money";
import {
  ALIAS_KIND_LABEL, ALIAS_KINDS, catalogLabel, isSuperseded, kitContents, MAX_PART_PHOTOS,
  PART_KINDS, PART_KIND_LABEL, searchCatalog, type PartAlias,
} from "@/lib/partCatalog";
import type { UncataloguedPart } from "@/lib/partCatalog";
import type { Tone } from "@/lib/tones";
import PartNumberField, { forgetCatalog } from "./PartNumberField";

export type CatalogRow = {
  id: number; partNumber: string; name: string; manufacturer: string; mfrPartNumber: string;
  kind: string; assetTypes: string[]; models: string[]; note: string; archived: boolean;
  lines: { partNumber: string; name: string; qty: number }[];
  /** Its other numbers - ours and the makers'. See lib/partCatalog. */
  aliases: PartAlias[];
  /** What it looks like. First is the cover. */
  photos: PartPhoto[];
};

export type PartPhoto = { id: number; url: string; caption: string };

const KIND_TONE: Record<string, Tone> = {
  part: "info",
  consumable: "warn",
  kit: "accent",
};

const emptyDraft = {
  partNumber: "", name: "", manufacturer: "", mfrPartNumber: "",
  kind: "part", assetTypes: [] as string[], models: [] as string[], note: "",
  aliases: [] as PartAlias[],
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
export type VendorPrice = {
  id: number; partNumber: string; vendor: string; isOem: boolean; priceCents: number; url: string;
};

export default function PartCatalogPanel({ items, assetTypes, modelsByType, prices = [], unnamed, makers = [], initialFacet = "" }: {
  items: CatalogRow[];
  assetTypes: string[];
  /** Catalog models per module type, for the per-model chips. */
  modelsByType: Record<string, string[]>;
  /** The price book's rows, so vendors and prices are set right here. */
  prices?: VendorPrice[];
  /** Part numbers in use on real work that the catalog has never heard of. */
  unnamed: UncataloguedPart[];
  /** The maker/vendor book (Settings → Catalog), suggested on every maker and vendor field. */
  makers?: string[];
  /** Facet from the URL (?f=), so a filtered book is a link. */
  initialFacet?: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  type Facet = "all" | "part" | "consumable" | "kit" | "retired" | "undescribed";
  const FACETS: Facet[] = ["all", "part", "consumable", "kit", "retired", "undescribed"];
  const facet: Facet = FACETS.includes(initialFacet as Facet) && initialFacet !== "" ? (initialFacet as Facet) : "all";
  // The facet lives in the URL so a filtered book is a link.
  const setFacet = (f: Facet) =>
    router.replace(f === "all" ? "/settings/parts" : `/settings/parts?f=${f}`, { scroll: false });
  const [sheet, setSheet] = useState<null | { id?: number }>(null);
  const [draft, setDraft] = useState(emptyDraft);
  const [lines, setLines] = useState<{ partNumber: string; name: string; qty: number }[]>([]);
  const [vendorDraft, setVendorDraft] = useState({ vendor: "", price: "", isOem: false, url: "" });
  const [busy, setBusy] = useState("");
  const photoInput = useRef<HTMLInputElement>(null);
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const shown = useMemo(() => searchCatalog(items, query, 200), [items, query]);

  const openAdd = (partNumber = "") => {
    setDraft({ ...emptyDraft, partNumber });
    setLines([]); setError(""); setSheet({});
  };
  // Describing a part maintenance already knows is confirming, not typing:
  // the PM procedure carried its name, module type and models here.
  const openDescribe = (u: UncataloguedPart) => {
    setDraft({ ...emptyDraft, partNumber: u.partNumber, name: u.name, assetTypes: u.assetTypes, models: u.models });
    setLines([]); setError(""); setSheet({});
  };
  const openEdit = (r: CatalogRow) => {
    setDraft({
      partNumber: r.partNumber, name: r.name, manufacturer: r.manufacturer,
      mfrPartNumber: r.mfrPartNumber, kind: r.kind, assetTypes: r.assetTypes,
      models: r.models, note: r.note, aliases: r.aliases.map((a) => ({ ...a })),
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
      // The book just changed; the next field to open must see it.
      forgetCatalog();
      setSheet(null);
      toast({ message: `Saved ${draft.partNumber.trim()}` });
    });
  };

  const live = items.filter((r) => !r.archived);
  const shownRows = shown.filter((r) =>
    facet === "all" ? !r.archived
    : facet === "retired" ? r.archived
    : facet === "undescribed" ? false
    : !r.archived && r.kind === facet);

  const bestPrice = (partNumber: string) => {
    const mine = prices.filter((p) => p.partNumber.toLowerCase() === partNumber.toLowerCase());
    if (!mine.length) return "";
    const best = mine.reduce((a, b) => (a.priceCents <= b.priceCents ? a : b));
    return `${formatCents(best.priceCents)} at ${best.vendor}${mine.length > 1 ? ` (+${mine.length - 1} more)` : ""}`;
  };

  const toRow = (r: CatalogRow): DataRow => ({
    key: r.id,
    actions: [
      { label: "Edit", onClick: () => openEdit(r) },
      {
        label: r.archived ? "Restore" : "Retire",
        tone: r.archived ? undefined : "bad",
        onClick: () => startTransition(async () => {
          await archiveCatalogPart(r.id, !r.archived);
          toast({ message: `${r.archived ? "Restored" : "Retired"} ${r.partNumber}` });
        }),
      },
    ],
    cells: {
      pn: (
        <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          {/* What it looks like beats what it is called, for the one question
              this list gets asked at a bench: is this the thing in my hand? */}
          {r.photos[0] && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={r.photos[0].url} alt="" width={26} height={26}
              style={{ width: 26, height: 26, borderRadius: 6, objectFit: "cover", flexShrink: 0, border: "1px solid var(--line)" }} />
          )}
          <Id>{r.partNumber}</Id>
        </span>
      ),
      name: (
        <span style={{ minWidth: 0, display: "block", opacity: r.archived ? 0.55 : 1 }}>
          <span className="t-body" style={{ display: "block" }}>{r.name || <span className="mut">unnamed</span>}</span>
          <span className="mut t-meta" style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {[
              r.manufacturer && `${r.manufacturer}${r.mfrPartNumber ? ` ${r.mfrPartNumber}` : ""}`,
              r.kind === "kit" && r.lines.length ? kitContents(r.lines) : "",
              r.archived ? "retired" : "",
            ].filter(Boolean).join(" · ")}
          </span>
        </span>
      ),
      kind: <Pill tone={KIND_TONE[r.kind] ?? "info"}>{PART_KIND_LABEL[r.kind]}</Pill>,
      aka: r.aliases.length ? (
        /* The other numbers it answers to, as a count the row can afford -
           the full list, superseded ones marked, rides in the title. */
        <span className="mut t-meta"
          title={r.aliases.map((a) => `${isSuperseded(a) ? "was" : "="} ${a.partNumber}${a.manufacturer ? ` (${a.manufacturer})` : ""}`).join("\n")}>
          {r.aliases.length} other number{r.aliases.length === 1 ? "" : "s"}
        </span>
      ) : null,
      fit: (
        <span className="mut t-meta"
          title={[...r.assetTypes, ...r.models].join(", ") || undefined}>
          {[r.assetTypes.length ? r.assetTypes.join(", ") : "", r.models.length ? `${r.models.length} model${r.models.length === 1 ? "" : "s"}` : ""]
            .filter(Boolean).join(" · ")}
        </span>
      ),
      price: <span className="mut t-meta">{bestPrice(r.partNumber)}</span>,
    },
  });

  const undescribedRow = (u: UncataloguedPart): DataRow => ({
    key: u.partNumber,
    actions: [{ label: "Describe", onClick: () => openDescribe(u) }],
    cells: {
      pn: <Id>{u.partNumber}</Id>,
      name: (
        <span style={{ minWidth: 0, display: "block" }}>
          <span className="t-body" style={{ display: "block" }}>{u.name || <span className="mut">unnamed</span>}</span>
          <span className="mut t-meta" style={{ display: "block" }}>
            {[u.sources.join(", "), u.models.slice(0, 3).join(", ")].filter(Boolean).join(" · ")}
          </span>
        </span>
      ),
      kind: u.sources.includes("maintenance")
        ? <Pill tone="good" title="Named by a maintenance task or PM schedule">maintenance</Pill>
        : u.sources.includes("kit")
          ? <Pill tone="warn" title="Listed inside a kit's contents">in a kit</Pill>
          : null,
      aka: null,
      fit: null,
      price: null,
    },
  });

  return (
    <div>
      {/* One spelling of "Shimadzu", wherever it's typed - see Settings → Catalog. */}
      <datalist id="maker-book">{makers.map((m) => <option key={m} value={m} />)}</datalist>
      <PageHead
        title="Parts book"
        sub="What each part number means."
        actions={<button className="btn sm primary" onClick={() => openAdd()}>+ Part number</button>}
      />
      <Toolbar
        search={
          <input value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Your number, theirs, a name or a maker" aria-label="Search the parts book" />
        }
        facets={
          <FacetStrip
            facets={[
              { key: "all", label: "All", count: live.length, on: facet === "all" },
              ...PART_KINDS.map((k) => ({
                key: k, label: PART_KIND_LABEL[k],
                count: live.filter((r) => r.kind === k).length || undefined,
                on: facet === k,
              })),
              /* The numbers real work already used that nothing describes -
                 a filtered view of this ledger, not a second list below it. */
              ...(unnamed.length ? [{ key: "undescribed", label: "Used but not described", count: unnamed.length, on: facet === "undescribed" }] : []),
              ...(items.some((r) => r.archived)
                ? [{ key: "retired", label: "Retired", count: items.filter((r) => r.archived).length, on: facet === "retired" }]
                : []),
            ]}
            onToggle={(k) => setFacet(facet === k ? "all" : (k as typeof facet))}
          />
        }
      />
      {facet === "undescribed" && (
        <div className="mut t-meta" style={{ margin: "0 0 8px" }}>
          Numbers on real work - fitted, stocked, ordered, named by a maintenance task, or packed
          inside a kit - with no catalog entry yet. Describing one keeps everything already said about it.
        </div>
      )}
      <DataTable
        cols={[
          { key: "pn", label: "Part number", width: "minmax(140px, 1.1fr)" },
          { key: "name", label: "What it is", width: "minmax(180px, 1.8fr)" },
          { key: "kind", label: "Kind", width: "110px" },
          { key: "aka", label: "Also", width: "110px", hideMobile: true },
          { key: "fit", label: "Fits", width: "minmax(120px, 1fr)", hideMobile: true },
          { key: "price", label: "Best price", width: "minmax(120px, 1fr)", hideMobile: true },
        ]}
        rows={facet === "undescribed"
          ? unnamed.slice(0, 80).filter((u) => !query.trim() || `${u.partNumber} ${u.name}`.toLowerCase().includes(query.trim().toLowerCase())).map(undescribedRow)
          : shownRows.map(toRow)}
        empty={query ? "Nothing matches that" : "Nothing catalogued yet"}
      />

      {sheet && (
        <Dialog open onClose={() => setSheet(null)} title={sheet.id ? "Edit part number" : "New part number"}
          footer={
            <>
              <span className={`dialog-status${error ? " err" : ""}`}>
                {error || (draft.partNumber.trim()
                  ? catalogLabel({ partNumber: draft.partNumber, name: draft.name, manufacturer: draft.manufacturer })
                  : "A part number is the one thing this needs.")}
              </span>
              <button className="btn" onClick={() => setSheet(null)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={save} disabled={pending || !draft.partNumber.trim()}>
                {pending ? "Saving..." : "Save part"}
              </button>
            </>
          }>
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
                <input value={draft.manufacturer} list="maker-book" onChange={(e) => setDraft({ ...draft, manufacturer: e.target.value })}
                  placeholder="Agilent" />
              </div>
              <div>
                <label>Their number</label>
                <input className="mono" value={draft.mfrPartNumber}
                  onChange={(e) => setDraft({ ...draft, mfrPartNumber: e.target.value })}
                  placeholder="G4521-67001" />
              </div>
            </div>

            {/* Every OTHER number the same part answers to. The pair above is
                the display identity - what the row is called and what every
                other table stores as a bare string - and these make all of
                them resolve to this one entry. Without it, buying the seal
                under a third party's number puts a second undescribed part in
                the book for the same thing. */}
            <label>Its other numbers <span className="mut" style={{ fontWeight: 400 }}>(optional)</span></label>
            <div style={{ marginBottom: 10 }}>
              {draft.aliases.map((a, idx) => {
                const setAlias = (patch: Partial<PartAlias>) =>
                  setDraft({ ...draft, aliases: draft.aliases.map((x, i) => (i === idx ? { ...x, ...patch } : x)) });
                return (
                  <div key={idx} style={{ display: "flex", gap: 6, marginBottom: 4, alignItems: "center", flexWrap: "wrap" }}>
                    <select value={a.kind} onChange={(e) => setAlias({ kind: e.target.value })}
                      aria-label="Whose number this is" className="t-small" style={{ width: "auto" }}>
                      {ALIAS_KINDS.map((k) => <option key={k} value={k}>{ALIAS_KIND_LABEL[k]}</option>)}
                    </select>
                    <input className="mono t-small" value={a.partNumber} placeholder="PN"
                      aria-label="Part number"
                      onChange={(e) => setAlias({ partNumber: e.target.value })}
                      style={{ flex: "1 1 130px" }} />
                    <input value={a.manufacturer ?? ""} list="maker-book" placeholder={a.kind === "shop" ? "-" : "Who makes it"}
                      aria-label="Manufacturer" disabled={a.kind === "shop"}
                      onChange={(e) => setAlias({ manufacturer: e.target.value })}
                      className="t-small" style={{ flex: "1 1 110px" }} />
                    <input value={a.note ?? ""} placeholder={isSuperseded(a) ? "when it changed" : "e.g. pack of 10"}
                      aria-label="Note"
                      onChange={(e) => setAlias({ note: e.target.value })}
                      className="t-small" style={{ flex: "1 1 120px" }} />
                    <button className="btn link" aria-label={`Remove ${a.partNumber || "number"}`}
                      style={{ color: "var(--t-bad-fg)", fontSize: 13 }}
                      onClick={() => setDraft({ ...draft, aliases: draft.aliases.filter((_, i) => i !== idx) })}>×</button>
                  </div>
                );
              })}
              <button className="btn sm" onClick={() => setDraft({ ...draft, aliases: [...draft.aliases, { kind: "oem", partNumber: "", manufacturer: "", note: "" }] })}>
                ＋ Number
              </button>
              <div className="mut" style={{ fontSize: 10.5, marginTop: 4 }}>
                Anything typed here finds this part - in a picker, on a purchase order, and in
                the list of numbers nobody has described. <b style={{ fontWeight: 700 }}>Superseded</b> keeps
                an old number look-up-able for the records that still quote it, and orders
                {" "}<span className="mono">{draft.partNumber || "this part"}</span> in its place.
              </div>
            </div>

            {/* What it looks like. Only once the entry exists, because a photo
                has to hang off a row - and an upload is immediate rather than
                held to Save, so it is never lost by a validation error on some
                other field. */}
            {sheet?.id !== undefined && (() => {
              const row = items.find((x) => x.id === sheet.id);
              const photos = row?.photos ?? [];
              const upl = async (list: FileList | null) => {
                const files = Array.from(list ?? []);
                if (!files.length || sheet.id === undefined) return;
                setError("");
                try {
                  const done: { url: string }[] = [];
                  for (const f of files) {
                    setBusy(`Uploading ${f.name}...`);
                    const blob = await upload(f.name, f, { access: "public", handleUploadUrl: "/api/upload" });
                    done.push({ url: blob.url });
                  }
                  const res = await addPartPhotos(sheet.id, done);
                  if (res?.error) setError(res.error);
                  else router.refresh();
                } catch (e) {
                  setError((e as Error).message);
                } finally { setBusy(""); }
              };
              return (
                <div style={{ marginBottom: 10 }}>
                  <label>Photos <span className="mut" style={{ fontWeight: 400 }}>({photos.length}/{MAX_PART_PHOTOS})</span></label>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 6 }}>
                    {photos.map((ph, i) => (
                      <div key={ph.id} style={{ width: 104 }}>
                        <div style={{ position: "relative" }}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={ph.url} alt={ph.caption} width={104} height={78}
                            style={{ width: 104, height: 78, objectFit: "cover", borderRadius: 6, border: i === 0 ? "2px solid var(--navy)" : "1px solid var(--line)" }} />
                          <button className="btn link" aria-label="Remove photo" disabled={pending}
                            title="Remove this photo"
                            onClick={() => startTransition(async () => {
                              const res = await removePartPhoto(ph.id);
                              if (res?.error) setError(res.error); else router.refresh();
                            })}
                            style={{ position: "absolute", top: 2, right: 2, background: "#fff", borderRadius: 4, color: "var(--t-bad-fg)", fontSize: 12, lineHeight: 1, padding: "1px 4px" }}>×</button>
                        </div>
                        <input defaultValue={ph.caption} placeholder={i === 0 ? "cover" : "what this shows"}
                          aria-label="Caption"
                          onBlur={(e) => {
                            if (e.target.value === ph.caption) return;
                            startTransition(async () => { await setPartPhotoCaption(ph.id, e.target.value); router.refresh(); });
                          }}
                          className="t-meta" style={{ width: "100%", padding: "3px 5px", marginTop: 2 }} />
                        {i > 0 && (
                          <button className="btn link" style={{ fontSize: 10.5 }} disabled={pending}
                            onClick={() => startTransition(async () => { await makePartPhotoCover(ph.id); router.refresh(); })}>
                            make cover
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                  <button className="btn sm" disabled={!!busy || photos.length >= MAX_PART_PHOTOS}
                    onClick={() => photoInput.current?.click()}>
                    {busy || "＋ Photo"}
                  </button>
                  <input ref={photoInput} type="file" accept="image/*" multiple style={{ display: "none" }}
                    onChange={(e) => { void upl(e.target.files); e.target.value = ""; }} />
                  <div className="mut" style={{ fontSize: 10.5, marginTop: 4 }}>
                    One photo of this number is a photo of every one of them, so it belongs here rather
                    than on a record - it shows wherever the number does, on nobody&apos;s storage bill.
                  </div>
                </div>
              );
            })()}

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
                <div className="mut t-meta" style={{ marginBottom: 6 }}>
                  For reading, not for counting. A kit is stocked and issued as one sealed bag -
                  exploding it would have the shelf claim ten septa are loose when they are not.
                </div>
                {lines.map((l, i) => (
                  <div key={i} style={{ display: "flex", gap: 6, marginBottom: 4 }}>
                    <input type="number" min={1} value={l.qty} aria-label="Quantity" className="t-small" style={{ width: 64 }}
                      onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, qty: parseInt(e.target.value) || 1 } : x))} />
                    {/* A kit's contents are the fastest way to put undescribed
                        numbers in the book; resolving here means the ones that
                        ARE described arrive with their real number and name. */}
                    <PartNumberField value={l.partNumber} style={{ flex: "0 1 140px", fontSize: 12 }}
                      onChange={(partNumber) => setLines(lines.map((x, j) => j === i ? { ...x, partNumber } : x))}
                      onPick={(part) => setLines(lines.map((x, j) => j === i
                        ? { ...x, partNumber: part.partNumber, name: x.name.trim() || part.name } : x))} />
                    <input value={l.name} placeholder="What it is" className="t-small" style={{ flex: 1 }}
                      onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, name: e.target.value } : x))} />
                    <button className="btn link"
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
              {assetTypes.length === 0 && <span className="mut t-meta">No module types in the catalog yet.</span>}
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

            {/* Who sells it and for how much: the OEM and the secondary vendors,
                each with a link. Same rows the price book shows; "Request part"
                on a maintenance job pulls the cheapest offer from here. */}
            <label>Vendors &amp; prices</label>
            <div style={{ marginBottom: 8 }}>
              {prices.filter((p) => p.partNumber.toLowerCase() === draft.partNumber.trim().toLowerCase()).map((p) => (
                <div key={p.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0", borderBottom: "1px solid var(--line)", fontSize: 12.5 }}>
                  <span style={{ fontWeight: 600 }}>{p.vendor}</span>
                  {p.isOem && <span className="pill info">OEM</span>}
                  <span className="mono">{formatCents(p.priceCents)}</span>
                  {p.url && <a href={p.url} target="_blank" rel="noreferrer" className="t-meta">link ↗</a>}
                  <button className="btn link" aria-label={`Remove ${p.vendor}'s price`} disabled={pending}
                    style={{ marginLeft: "auto", color: "var(--t-bad-fg)", fontSize: 12 }}
                    onClick={() => startTransition(async () => { await deletePartPrice(p.id); router.refresh(); })}>×</button>
                </div>
              ))}
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 6 }}>
                <input value={vendorDraft.vendor} list="maker-book" placeholder="Vendor"
                  onChange={(e) => setVendorDraft({ ...vendorDraft, vendor: e.target.value })}
                  className="t-small" style={{ flex: "1 1 110px" }} />
                <input value={vendorDraft.price} placeholder="$" inputMode="decimal"
                  onChange={(e) => setVendorDraft({ ...vendorDraft, price: e.target.value })}
                  className="t-small" style={{ flex: "0 1 80px" }} />
                <input className="mono t-small" value={vendorDraft.url} placeholder="https://... (optional)"
                  onChange={(e) => setVendorDraft({ ...vendorDraft, url: e.target.value })}
                  style={{ flex: "2 1 160px" }} />
                <label className="t-meta" style={{ display: "flex", alignItems: "center", gap: 4, margin: 0, fontWeight: 400, color: "var(--ink)" }}>
                  <input type="checkbox" checked={vendorDraft.isOem} style={{ width: 14, height: 14 }}
                    onChange={(e) => setVendorDraft({ ...vendorDraft, isOem: e.target.checked })} />
                  OEM
                </label>
                <button type="button" className="btn sm" disabled={pending || !draft.partNumber.trim() || !vendorDraft.vendor.trim() || !vendorDraft.price.trim()}
                  onClick={() => {
                    setError("");
                    startTransition(async () => {
                      const res = await addPartPrices([{
                        partNumber: draft.partNumber, vendor: vendorDraft.vendor,
                        price: vendorDraft.price, isOem: vendorDraft.isOem, url: vendorDraft.url,
                      }]);
                      if (res?.error) { setError(res.error); return; }
                      if (res.failures?.length) { setError(res.failures[0].error); return; }
                      setVendorDraft({ vendor: "", price: "", isOem: false, url: "" });
                      router.refresh();
                    });
                  }}>＋ Vendor</button>
              </div>
              {!draft.partNumber.trim() && (
                <div className="mut" style={{ fontSize: 10.5, marginTop: 3 }}>Type the part number first - prices hang off it.</div>
              )}
            </div>

            <label>Note</label>
            <textarea value={draft.note} rows={2} style={{ width: "100%", marginBottom: 8 }}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })} />

        </Dialog>
      )}
    </div>
  );
}
