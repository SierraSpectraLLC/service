// One page of a long list.
//
// Written for the equipment catalog, which drew all 1,118 models as cards in
// one column of DOM and produced a page nobody could reach the bottom of. The
// list is already in memory - the fix is not fetching less, it is drawing
// less - so this is arithmetic over an array and nothing more.
//
// Pure, and shared rather than inlined, because the two things that go wrong
// with paging both go wrong quietly and both go wrong once per implementation:
// a page number that outlives the list it was counting, and an off-by-one in
// the "showing 61-120 of 1,118" line that nobody notices until a customer
// counts.

export type Page<T> = {
  /** The slice to draw. */
  rows: T[];
  /** The page actually shown, which is not always the one asked for. */
  page: number;
  /** How many there are. Always at least 1, so "1 of 1" reads for an empty list. */
  pages: number;
  /** 1-based, inclusive, for the "showing X-Y of Z" line. Zero when empty. */
  from: number;
  to: number;
  total: number;
};

/**
 * A page of rows, with a page number that cannot fall off the end.
 *
 * CLAMPED, and that is the whole reason this is a function rather than a
 * slice at the call site. A filter narrows the list under whatever page the
 * reader is on: type three letters into a search while on page 12 and the
 * naive slice returns nothing at all, which renders as "no models match" over
 * a list that matched four. Clamping shows the last real page instead.
 *
 * The caller should still reset to page 1 when the filter changes - landing on
 * the last page of a fresh search is not what anybody meant - and this is the
 * backstop for every path that forgets, not a replacement for it.
 */
export function pageOf<T>(rows: T[], page: number, size: number): Page<T> {
  const per = Math.max(1, Math.floor(size));
  const total = rows.length;
  const pages = Math.max(1, Math.ceil(total / per));
  const want = Number.isFinite(page) ? Math.floor(page) : 1;
  const at = Math.min(Math.max(1, want), pages);
  const start = (at - 1) * per;
  const slice = rows.slice(start, start + per);
  return {
    rows: slice,
    page: at,
    pages,
    // Zero on an empty list rather than "1-0 of 0", which reads as a bug.
    from: total === 0 ? 0 : start + 1,
    to: total === 0 ? 0 : start + slice.length,
    total,
  };
}

/** "Showing 61-120 of 1,118" - or the whole truth when it all fits. */
export function pageLabel(p: Page<unknown>, noun: string): string {
  const n = (x: number) => x.toLocaleString("en-US");
  if (p.total === 0) return `No ${noun}`;
  if (p.pages === 1) return `${n(p.total)} ${p.total === 1 ? noun.replace(/s$/, "") : noun}`;
  return `${n(p.from)}-${n(p.to)} of ${n(p.total)} ${noun}`;
}
