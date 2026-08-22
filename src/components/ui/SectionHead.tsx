/**
 * A section heading inside a list page: label, count, room for one action.
 * Same uppercase voice as .band-label, without the trailing rule - these sit
 * over tables and grids that draw their own top edge. `sticky` for long
 * pages where the heading should still say where you are at row 80.
 */
export default function SectionHead({ label, count, action, sticky }: {
  label: React.ReactNode;
  count?: number;
  action?: React.ReactNode;
  sticky?: boolean;
}) {
  return (
    <div className={`sec-head${sticky ? " sticky" : ""}`}>
      {label}
      {count != null && <span className="sec-count">{count}</span>}
      {action != null && (
        <>
          <span className="sp" />
          {action}
        </>
      )}
    </div>
  );
}
