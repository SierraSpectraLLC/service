"use client";

import { useState } from "react";

/**
 * A strict picker over the equipment catalog. Deliberately NOT pick-or-type:
 * types, models and categories are defined once in Settings > Catalog and
 * referenced everywhere else, so "LC-20" spelled four ways can't happen. A
 * value already on the record stays selectable even if it has since left the
 * catalog - editing an old unit must never corrupt it.
 *
 * `allowNew` is the deliberate exception, for recording real equipment: the
 * list gains a "+ New model..." row that flips to a text input, because the
 * unit in front of somebody always gets recorded - the catalog is the source,
 * not a cage. What lands is flagged for review (see the catalog page), so
 * the book stays curated without ever blocking the shop floor.
 */
const NEW = "__new__";

export default function CatalogSelect({ value, options, onChange, hint, ariaLabel, allowNew }: {
  value: string;
  options: string[];
  onChange: (next: string) => void;
  /** Shown under an empty or sparse list - where to go to define more. */
  hint?: string;
  ariaLabel?: string;
  /** Label for the escape hatch, e.g. '+ New model...'. Absent = strict. */
  allowNew?: string;
}) {
  const [typing, setTyping] = useState(false);
  const list = [...new Set([...options, ...(value && !options.includes(value) ? [value] : [])].filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));

  if (allowNew && typing) {
    return (
      <div>
        <input value={value} autoFocus aria-label={ariaLabel}
          placeholder="Type the model as it reads on the unit"
          onChange={(e) => onChange(e.target.value)} />
        <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
          <button type="button" className="btn link" style={{ fontSize: 10 }}
            onClick={() => { setTyping(false); if (!options.includes(value)) onChange(""); }}>
            pick from the catalog instead
          </button>
          {value.trim() && !options.some((o) => o.toLowerCase() === value.trim().toLowerCase()) && (
            <span className="mut" style={{ fontSize: 10 }}>New - it&apos;ll be flagged for catalog review.</span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div>
      <select value={value} aria-label={ariaLabel}
        onChange={(e) => {
          if (e.target.value === NEW) { onChange(""); setTyping(true); return; }
          onChange(e.target.value);
        }}>
        <option value="">-</option>
        {list.map((o) => <option key={o} value={o}>{o}</option>)}
        {allowNew && <option value={NEW}>{allowNew}</option>}
      </select>
      {list.length === 0 && hint && (
        <div className="mut" style={{ fontSize: 10, marginTop: 2 }}>{hint}</div>
      )}
    </div>
  );
}
