/**
 * The list page's working row, sticky under the header: search on the left,
 * facets beside it, the odd action pushed right. Slots, not markup - the
 * caller passes a search input, a FacetStrip, buttons.
 */
export default function Toolbar({ search, lead, facets, actions }: {
  search?: React.ReactNode;
  /**
   * Buttons that belong BESIDE the search box rather than pushed to the far
   * edge - a page's "new one of these", which is looked for next to the thing
   * somebody just searched.
   *
   * Before the facets rather than after, and that ordering is the whole point:
   * the row wraps, and a long facet strip takes a line of its own, so anything
   * placed after it lands a line below the search box instead of next to it.
   */
  lead?: React.ReactNode;
  facets?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="toolbar">
      {search != null && <div className="toolbar-search">{search}</div>}
      {lead}
      {facets}
      {actions != null && (
        <>
          <span className="sp" />
          {actions}
        </>
      )}
    </div>
  );
}
