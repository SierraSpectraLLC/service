import Pill from "@/components/ui/Pill";
import EmptyState from "@/components/ui/EmptyState";

/**
 * The one card chrome for record pages: title, count, actions right, body.
 * A .card that agreed to a shape, so twenty panels on an instrument page
 * stop each inventing their own title row. Pass `empty` and no children and
 * the panel still reads as designed with nothing in it.
 */
export default function Panel({ title, count, actions, hint, empty, children }: {
  title: React.ReactNode;
  count?: number;
  actions?: React.ReactNode;
  /** A line of context under the title, before the body. */
  hint?: React.ReactNode;
  /** Shown as the empty-state title when there is no body to render. */
  empty?: string;
  children?: React.ReactNode;
}) {
  const bare = children == null || children === false;
  return (
    <div className="card">
      <div className="panel-head">
        <span className="card-title">{title}</span>
        {count != null && <Pill tone="neutral">{count}</Pill>}
        {actions != null && (
          <>
            <span className="sp" />
            {actions}
          </>
        )}
      </div>
      {hint != null && <div className="panel-hint">{hint}</div>}
      {bare && empty ? <EmptyState title={empty} /> : children}
    </div>
  );
}
