/**
 * Nothing here yet, said properly: wraps the existing .empty block. One
 * sentence and at most one action - an empty page is not the place to
 * explain the feature.
 */
export default function EmptyState({ title, body, action }: {
  title: React.ReactNode;
  body?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <b>{title}</b>
      {body}
      {action != null && <div className="empty-act">{action}</div>}
    </div>
  );
}
