"use client";

import Link from "next/link";

/**
 * Counted facet pills: the page's quick filters, with real counts. One row
 * that scrolls sideways on a phone instead of wrapping into a wall
 * (globals.css owns that). A facet with no count is just its label.
 *
 * Two flavours: give a facet an `href` and it renders as a link - the list
 * pages keep facet state in the URL so a filtered view can be shared and
 * survives reload - or pass `onToggle` for purely client-side state.
 */
export type Facet = { key: string; label: string; count?: number; on?: boolean; href?: string };

export default function FacetStrip({ facets, onToggle }: {
  facets: Facet[];
  onToggle?: (key: string) => void;
}) {
  return (
    <div className="facets">
      {facets.map((f) =>
        f.href != null ? (
          <Link
            key={f.key}
            className={`facet${f.on ? " on" : ""}`}
            aria-current={f.on ? "true" : undefined}
            href={f.href}
          >
            {f.label}
            {f.count != null && <b>{f.count}</b>}
          </Link>
        ) : (
          <button
            key={f.key}
            type="button"
            className={`facet${f.on ? " on" : ""}`}
            aria-pressed={f.on ?? false}
            onClick={() => onToggle?.(f.key)}
          >
            {f.label}
            {f.count != null && <b>{f.count}</b>}
          </button>
        ),
      )}
    </div>
  );
}
