import Pill from "@/components/ui/Pill";
import EmptyState from "@/components/ui/EmptyState";
import type { Tone } from "@/lib/tones";

/**
 * The one card chrome for record pages: title, count, actions right, body.
 * A .card that agreed to a shape, so twenty panels on an instrument page
 * stop each inventing their own title row. Pass `empty` and no children and
 * the panel still reads as designed with nothing in it.
 */
export default function Panel({ title, count, actions, hint, empty, tone, children }: {
  title: React.ReactNode;
  count?: number;
  actions?: React.ReactNode;
  /**
   * The status this panel carries, worn as a full border in a softened tint of
   * the tone (--t-{tone}-bd). Not the saturated dot colour, which shouts at
   * card size, and not the old .pane left edge, which reads as a decoration on
   * one side rather than as a property of the box. Untoned panels keep the
   * plain --line border, and there is deliberately no filled variant: a card
   * with a coloured background is a one-off somebody argues for, not a knob.
   */
  tone?: Tone;
  /** A line of context under the title, before the body. */
  hint?: React.ReactNode;
  /** Shown as the empty-state title when there is no body to render. */
  empty?: string;
  children?: React.ReactNode;
}) {
  const bare = children == null || children === false;
  return (
    <div className={`card${tone ? ` tone-${tone}` : ""}`}>
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
