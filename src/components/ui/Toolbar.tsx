/**
 * The list page's working row, sticky under the header: search on the left,
 * facets beside it, the odd action pushed right. Slots, not markup - the
 * caller passes a search input, a FacetStrip, buttons.
 */
export default function Toolbar({ search, facets, actions }: {
  search?: React.ReactNode;
  facets?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="toolbar">
      {search != null && <div className="toolbar-search">{search}</div>}
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
