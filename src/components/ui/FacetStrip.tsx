"use client";

/**
 * Counted facet pills: the page's quick filters, with real counts. One row
 * that scrolls sideways on a phone instead of wrapping into a wall
 * (globals.css owns that). A facet with no count is just its label.
 */
export type Facet = { key: string; label: string; count?: number; on?: boolean };

export default function FacetStrip({ facets, onToggle }: {
  facets: Facet[];
  onToggle: (key: string) => void;
}) {
  return (
    <div className="facets">
      {facets.map((f) => (
        <button
          key={f.key}
          type="button"
          className={`facet${f.on ? " on" : ""}`}
          aria-pressed={f.on ?? false}
          onClick={() => onToggle(f.key)}
        >
          {f.label}
          {f.count != null && <b>{f.count}</b>}
        </button>
      ))}
    </div>
  );
}
