/**
 * "What page am I on and what can I do here" - wraps the existing .page-head
 * pattern (title left, actions right, one-line sub underneath), plus the
 * optional breadcrumb above it. `crumb` is composed by the caller (links and
 * text) so this component doesn't guess at routes.
 *
 * THE FIRST 100px OF EVERY PAGE. Half the app opened with a header built by
 * hand instead - different title sizes, different action placement, different
 * back affordances - and pages that open differently read as different apps
 * whatever else they share. The slots below are the ones those hand-built
 * headers had and this did not, so there is nothing left that a page needs a
 * bespoke header FOR: crumb, actions, and now status.
 */
export default function PageHead({ title, sub, crumb, status, actions }: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  crumb?: React.ReactNode;
  /**
   * What is true about this page right now - a pill, a stage, a tone dot.
   * Beside the title rather than in the actions: it is a fact, and the actions
   * are things you can do. Pages that carried one built their own header to
   * put it somewhere.
   */
  status?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <>
      {crumb != null && <div className="crumb">{crumb}</div>}
      <div className="page-head">
        <h1 className="page-title">
          {title}
          {status != null && <span className="page-status">{status}</span>}
        </h1>
        {actions != null && <div className="page-actions">{actions}</div>}
        {sub != null && <p className="page-sub">{sub}</p>}
      </div>
    </>
  );
}
