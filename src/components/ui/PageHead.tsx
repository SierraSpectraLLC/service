/**
 * "What page am I on and what can I do here" - wraps the existing .page-head
 * pattern (title left, actions right, one-line sub underneath), plus the
 * optional breadcrumb above it. `crumb` is composed by the caller (links and
 * text) so this component doesn't guess at routes.
 */
export default function PageHead({ title, sub, crumb, actions }: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  crumb?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <>
      {crumb != null && <div className="crumb">{crumb}</div>}
      <div className="page-head">
        <h1 className="page-title">{title}</h1>
        {actions != null && <div className="page-actions">{actions}</div>}
        {sub != null && <p className="page-sub">{sub}</p>}
      </div>
    </>
  );
}
