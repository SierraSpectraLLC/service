"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { upload } from "@vercel/blob/client";
import {
  addCatalogPart, addPartPhotos, addPartPrices, archiveCatalogPart, deletePartPrice,
  makePartPhotoCover, removePartPhoto, setKitLines, setPartPhotoCaption, updateCatalogPart,
} from "@/app/actions";
import Dialog from "@/components/ui/Dialog";
import { DataTable, FacetStrip, Id, PageHead, Pill, TokenPicker, Toolbar } from "@/components/ui";
import type { DataRow } from "@/components/ui/DataTable";
import { toast } from "@/components/ui/Toast";
import { formatCents } from "@/lib/money";
import { isStalePrice } from "@/lib/sourcing";
import {
  ALIAS_KIND_LABEL, ALIAS_KINDS, catalogLabel, CATALOG_KINDS, isService, isSuperseded, kitContents,
  MAX_PART_PHOTOS, PART_KIND_LABEL, searchCatalog, unitFor, type PartAlias,
} from "@/lib/partCatalog";
import type { UncataloguedPart } from "@/lib/partCatalog";
import type { Tone } from "@/lib/tones";
import PartDialog, { type KitLine, type PartDraft } from "./PartDialog";

export type CatalogRow = {
  id: number; partNumber: string; name: string; manufacturer: string; mfrPartNumber: string;
  kind: string; assetTypes: string[]; models: string[]; note: string; archived: boolean;
  /** A service code's price and unit. Zero and blank on a thing in a box. */
  rateCents: number; unit: string;
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
  labor: "good",
  travel: "neutral",
};

const emptyDraft = {
  partNumber: "", name: "", manufacturer: "", mfrPartNumber: "",
  kind: "part", assetTypes: [] as string[], models: [] as string[], note: "",
  aliases: [] as PartAlias[], rate: "", unit: "",
};

/**
 * The shop's own parts catalog: what each number IS.
 *
 * The list on the right of this panel is the one that makes a catalog actually
 * get filled in - the numbers already used on real work that nothing has ever
 * described. Asking somebody to type out their parts catalog from scratch is how a
 * catalog stays empty; asking them to name the twelve numbers they used last
 * month is a job somebody finishes.
 */
export type VendorPrice = {
  id: number; partNumber: string; vendor: string; isOem: boolean; priceCents: number; url: string;
  leadDays: number | null; dropShips: boolean; expediteOk: boolean;
  /** ISO date of the last confirmation, for the staleness flag. */
  updatedOn: string;
};

export default function PartCatalogPanel({ items, assetTypes, modelsByType, prices = [], unnamed, makers = [], initialFacet = "", today = "" }: {
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
  /** The shop's today, for flagging prices nobody has confirmed lately. */
  today?: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  type Facet = "all" | "part" | "consumable" | "kit" | "labor" | "travel" | "retired" | "undescribed";
  const FACETS: Facet[] = ["all", "part", "consumable", "kit", "labor", "travel", "retired", "undescribed"];
  const facet: Facet = FACETS.includes(initialFacet as Facet) && initialFacet !== "" ? (initialFacet as Facet) : "all";
  // The facet lives in the URL so a filtered book is a link.
  const setFacet = (f: Facet) =>
    router.replace(f === "all" ? "/settings/parts" : `/settings/parts?f=${f}`, { scroll: false });
  /* What the dialog opens WITH, rather than a draft this component keeps: the
     form owns its own editing state now, so the two pages that open it cannot
     drift apart. See PartDialog. */
  const [sheet, setSheet] = useState<null | { id?: number; seed?: Partial<PartDraft>; lines?: KitLine[] }>(null);
  const [pending, startTransition] = useTransition();

  const shown = useMemo(() => searchCatalog(items, query, 200), [items, query]);

  const openAdd = (partNumber = "") => setSheet({ seed: { partNumber } });
  // Describing a part maintenance already knows is confirming, not typing:
  // the PM procedure carried its name, module type and models here.
  const openDescribe = (u: UncataloguedPart) => setSheet({
    seed: { partNumber: u.partNumber, name: u.name, assetTypes: u.assetTypes, models: u.models },
  });
  const openEdit = (r: CatalogRow) => setSheet({
    id: r.id,
    seed: {
      partNumber: r.partNumber, name: r.name, manufacturer: r.manufacturer,
      mfrPartNumber: r.mfrPartNumber, kind: r.kind, assetTypes: r.assetTypes,
      models: r.models, note: r.note, aliases: r.aliases.map((a) => ({ ...a })),
      // Dollars in the form, cents on the row - the same boundary every price
      // field crosses. Blank rather than "0.00" so an unpriced code reads as
      // one nobody has priced.
      rate: r.rateCents > 0 ? (r.rateCents / 100).toFixed(2) : "", unit: r.unit,
    },
    lines: r.lines.map((l) => ({ ...l })),
  });

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
              /* What a service code sells for, said where a maker would be:
                 there is no maker, and the rate is the fact somebody opened
                 this row to check. Unpriced says so - it quotes at $0. */
              isService(r.kind)
                ? (r.rateCents > 0
                    ? `${formatCents(r.rateCents)}${unitFor(r) ? ` / ${unitFor(r)}` : ""}`
                    : "no rate set")
                : "",
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
      <PageHead
        title="Parts catalog"
        sub="What each part number means."
        actions={<button className="btn sm primary" onClick={() => openAdd()}>+ Part number</button>}
      />
      <Toolbar
        search={
          <input value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Your number, theirs, a name or a maker" aria-label="Search the parts catalog" />
        }
        facets={
          <FacetStrip
            facets={[
              { key: "all", label: "All", count: live.length, on: facet === "all" },
              ...CATALOG_KINDS.map((k) => ({
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
        empty={query ? "Nothing matches that" : "Nothing cataloged yet"}
      />

      {sheet && (
        <PartDialog
          id={sheet.id} seed={sheet.seed} seedLines={sheet.lines}
          assetTypes={assetTypes} modelsByType={modelsByType}
          prices={prices} makers={makers} today={today}
          photos={items.find((x) => x.id === sheet.id)?.photos ?? []}
          onClose={() => setSheet(null)} />
      )}
    </div>
  );
}
