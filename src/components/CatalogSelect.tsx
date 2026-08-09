"use client";

/**
 * A strict picker over the equipment catalog. Deliberately NOT pick-or-type:
 * types, models and categories are defined once in Settings > Catalog and
 * referenced everywhere else, so "LC-20" spelled four ways can't happen. A
 * value already on the record stays selectable even if it has since left the
 * catalog - editing an old unit must never corrupt it.
 */
export default function CatalogSelect({ value, options, onChange, hint, ariaLabel }: {
  value: string;
  options: string[];
  onChange: (next: string) => void;
  /** Shown under an empty or sparse list - where to go to define more. */
  hint?: string;
  ariaLabel?: string;
}) {
  const list = [...new Set([...options, ...(value && !options.includes(value) ? [value] : [])].filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  return (
    <div>
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={ariaLabel}>
        <option value="">-</option>
        {list.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
      {list.length === 0 && hint && (
        <div className="mut" style={{ fontSize: 10, marginTop: 2 }}>{hint}</div>
      )}
    </div>
  );
}
