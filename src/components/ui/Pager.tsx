"use client";

import type { Page } from "@/lib/paging";
import { pageLabel } from "@/lib/paging";

/**
 * Where you are in a long list, and the two steps through it.
 *
 * Renders NOTHING when it all fits on one page, which is most lists most of
 * the time - a disabled "1 of 1" with two dead arrows is chrome asking to be
 * read and then ignored.
 *
 * Numbers rather than infinite scroll: the catalog is a reference list people
 * search and come back to, and a position you can name is one you can return
 * to. It is also the only shape that lets somebody see they are looking at 60
 * of 1,118 rather than at everything there is.
 */
export default function Pager({ page, onPage, noun, label }: {
  page: Page<unknown>;
  onPage: (n: number) => void;
  /** Plural, for the count line: "models", "parts". */
  noun: string;
  /** What the control is stepping through, for the screen reader. */
  label: string;
}) {
  if (page.pages <= 1) return null;
  const step = (n: number) => () => onPage(Math.min(Math.max(1, n), page.pages));
  return (
    <nav aria-label={label}
      style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "0 0 12px" }}>
      <button className="btn sm" onClick={step(page.page - 1)} disabled={page.page <= 1}>
        ‹ Previous
      </button>
      <button className="btn sm" onClick={step(page.page + 1)} disabled={page.page >= page.pages}>
        Next ›
      </button>
      <span className="mut t-small" aria-live="polite">
        {pageLabel(page, noun)} · page {page.page} of {page.pages}
      </span>
      {/* A jump, because 1,118 models is nineteen presses of Next from one end
          to the other and somebody looking for Waters is not going to make it. */}
      {page.pages > 2 && (
        <>
          <span className="sp" />
          <label className="mut t-small" htmlFor="pager-jump" style={{ margin: 0 }}>Go to</label>
          <select id="pager-jump" value={page.page} className="t-small" style={{ width: "auto" }}
            aria-label={`Page of ${label}`}
            onChange={(e) => onPage(parseInt(e.target.value, 10) || 1)}>
            {Array.from({ length: page.pages }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </>
      )}
    </nav>
  );
}
