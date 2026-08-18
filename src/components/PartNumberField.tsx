"use client";

import { useEffect, useRef, useState } from "react";
import { catalogForLookup } from "@/app/actions";
import { PART_KIND_LABEL, suggestParts, type CatalogEntry, type PartSuggestion } from "@/lib/partCatalog";
import { formatCents } from "@/lib/money";

export type LookupPart = CatalogEntry & {
  photoUrl: string;
  /** Best known offer. Blank/null for anybody who may not see costs. */
  vendor: string;
  priceCents: number | null;
  isOem: boolean;
};

/**
 * The catalog, fetched once per page rather than once per field.
 *
 * A purchase order with eight lines has eight of these fields; a stock grid
 * has one per row. Each fetching its own copy would be the same query eight
 * times for a list that does not change while somebody types. The promise is
 * shared, so eight fields mounting at once make one request between them.
 */
let cache: Promise<LookupPart[]> | null = null;
const loadCatalog = (): Promise<LookupPart[]> => {
  cache ??= catalogForLookup().then((r) => r.parts as LookupPart[]).catch(() => []);
  return cache;
};
/** Called after the book changes, so the next field to open sees the new part. */
export const forgetCatalog = () => { cache = null; };

/**
 * A part number that resolves against the parts book before it is inserted.
 *
 * One field for the two ways somebody arrives at a part: with the box in their
 * hand and a number on it, or knowing what the thing is called and not its
 * number. "060-" offers every number starting that way; "uv bulb" offers the
 * bulb; the maker's number and any superseded number find it too. Picking one
 * inserts the CATALOG's number - which is what stops the same part accumulating
 * four spellings across five tables, and what stops a dead number reaching a
 * purchase order.
 *
 * It never insists. Free text is always allowed and always saved as typed: a
 * part fitted at 2am by somebody holding an unfamiliar box has to land in the
 * record whether or not the shop has catalogued it. That rule is why this is a
 * suggestion list and not a select.
 */
export default function PartNumberField({
  value, onChange, onPick, placeholder = "Part number", className = "mono",
  disabled = false, ariaLabel = "Part number", style, autoFocus = false,
}: {
  value: string;
  onChange: (partNumber: string) => void;
  /** Fired only when a catalog row is chosen, so callers can fill a description. */
  onPick?: (part: LookupPart) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  ariaLabel?: string;
  style?: React.CSSProperties;
  autoFocus?: boolean;
}) {
  const [parts, setParts] = useState<LookupPart[] | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  // Loaded on first focus, not on mount: a page with twenty of these should not
  // fetch anything until somebody actually reaches for one.
  const wake = () => { if (parts === null) void loadCatalog().then(setParts); };

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  const hits: PartSuggestion<LookupPart>[] = open && parts ? suggestParts(parts, value) : [];
  // Nothing to offer when the typed number IS the only match, spelled the same:
  // a dropdown restating what somebody just typed is noise.
  const worth = hits.filter((h) => h.partNumber.toLowerCase() !== value.trim().toLowerCase() || h.wasQuoted);

  const choose = (h: PartSuggestion<LookupPart>) => {
    onChange(h.partNumber);
    onPick?.(h.entry);
    setOpen(false);
  };

  return (
    <div ref={box} style={{ position: "relative", ...style }}>
      <input
        className={className} value={value} disabled={disabled} autoFocus={autoFocus}
        aria-label={ariaLabel} placeholder={placeholder} autoComplete="off"
        onFocus={() => { wake(); setOpen(true); }}
        onChange={(e) => { wake(); setActive(0); setOpen(true); onChange(e.target.value); }}
        onKeyDown={(e) => {
          if (!worth.length) return;
          if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => (i + 1) % worth.length); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => (i - 1 + worth.length) % worth.length); }
          else if (e.key === "Enter" && open) { e.preventDefault(); choose(worth[active] ?? worth[0]); }
          else if (e.key === "Escape") setOpen(false);
        }}
        style={{ width: "100%" }} />
      {open && worth.length > 0 && (
        <div role="listbox" aria-label="Matching parts" style={{
          position: "absolute", zIndex: 40, left: 0, right: 0, top: "calc(100% + 2px)",
          background: "#fff", border: "1px solid var(--line)", borderRadius: 8,
          boxShadow: "0 8px 24px rgba(15,23,42,.12)", maxHeight: 260, overflowY: "auto", minWidth: 260,
        }}>
          {worth.map((h, i) => (
            <button key={h.entry.id} type="button" role="option" aria-selected={i === active}
              onMouseEnter={() => setActive(i)} onClick={() => choose(h)}
              style={{
                display: "flex", gap: 8, alignItems: "center", width: "100%", textAlign: "left",
                padding: "6px 8px", border: "none", cursor: "pointer",
                background: i === active ? "#F1F5F9" : "#fff",
              }}>
              {h.entry.photoUrl && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={h.entry.photoUrl} alt="" width={26} height={26}
                  style={{ width: 26, height: 26, borderRadius: 4, objectFit: "cover", flexShrink: 0 }} />
              )}
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: "flex", gap: 6, alignItems: "baseline", flexWrap: "wrap" }}>
                  <span className="mono" style={{ fontSize: 12, fontWeight: 700, color: "var(--navy)" }}>{h.partNumber}</span>
                  <span style={{ fontSize: 12.5 }}>{h.name || <span className="mut">unnamed</span>}</span>
                  {/* What it costs, where the reader is allowed to know - the
                      answer to "is this the one to order" is half price. */}
                  {h.entry.priceCents !== null && (
                    <span className="pill" style={{ background: "#E8F3EC", color: "#2E6B2E" }}>
                      {formatCents(h.entry.priceCents)}{h.entry.vendor ? ` · ${h.entry.vendor}` : ""}
                    </span>
                  )}
                </span>
                {/* Why this row is here. Being offered 060-65005-91 after typing
                    060-65005-00 reads as the wrong answer unless it says why. */}
                <span className="mut" style={{ fontSize: 10.5, display: "block" }}>
                  {[
                    h.wasQuoted && `replaces ${h.wasQuoted}`,
                    h.alsoKnownAs && `also ${h.alsoKnownAs}`,
                    h.entry.manufacturer,
                    PART_KIND_LABEL[h.entry.kind],
                  ].filter(Boolean).join(" · ")}
                </span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
