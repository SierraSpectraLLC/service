/**
 * One sentence about the state of the thing you are looking at, and the
 * control that changes it.
 *
 * The record page uses it to say whose move it is; the financial section uses
 * it to say what is true about cash. Both replace the same failure: a page
 * that held every fact needed to answer an obvious question, in four separate
 * cards, and left the reader to assemble the answer - which mostly meant the
 * question went unanswered.
 *
 * A sentence rather than a row of chips because the answer has parts that only
 * mean anything together, and because "Lab Zen · 14d · quote" is a thing you
 * decode rather than read.
 *
 * The tone rides `data-tone` on this element, which publishes `--tone-fg` and
 * `--tone-bg` to everything inside it. A record page sets the same attribute
 * on its root so the working pane's rack spine carries the same colour; there,
 * this line and the spine agree because one rule decides both.
 */
export default function StatusLine({ tone, actions, children }: {
  /** The worst fact in the sentence, not the average of the facts. */
  tone: "good" | "warn" | "bad";
  /**
   * The one or two controls that end the wait. More than two and this has
   * stopped being a sentence with an answer and become a toolbar.
   */
  actions?: React.ReactNode;
  /** The sentence. Wrap measured values in <span className="fig">. */
  children: React.ReactNode;
}) {
  return (
    <div className="status-line" data-tone={tone}>
      <div className="txt">{children}</div>
      {actions}
    </div>
  );
}
