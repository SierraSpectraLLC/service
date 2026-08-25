"use client";

import { QUEUE_EVENT } from "@/components/QueuePanel";
import StatusLine from "@/components/ui/StatusLine";
import { standingTone } from "@/lib/panelMode";

/**
 * Whose move it is, in one sentence, above everything else on the record.
 *
 * The question this answers is "why is nothing happening on this machine",
 * and the banded page made you scroll past four cards to a Queue panel to find
 * it. A system parked with a client for three weeks looked exactly like one
 * being worked on this morning, which is how a system sits parked for three
 * weeks.
 *
 * It is a sentence rather than a row of chips because the answer has three
 * parts that only mean anything together - who, how long, and what they are
 * waiting on - and because "Lab Zen · 14d · quote" is a thing you decode
 * rather than read. The tone it carries drives the pane's rack spine, so the
 * standing stays in peripheral vision however far down the record you scroll.
 */
export default function StandingLine({
  holderName, isMine, days, since, reason, canMove, overdue,
}: {
  /** Who holds the queue right now, already resolved to a name. */
  holderName: string;
  /** True when the viewer is the one expected to act. */
  isMine: boolean;
  days: number;
  /** The day it landed there, already formatted. */
  since: string;
  /** What they are waiting on, in the words whoever parked it used. */
  reason: string;
  /** Whether this viewer may move it between queues at all. */
  canMove: boolean;
  /** Something behind this wait is already late - the wait is now costing. */
  overdue: boolean;
}) {
  // The same rule the page sets data-tone by on its root - one function, so
  // this line and the pane's rack spine can never disagree.
  const tone = standingTone({ isMine, overdue });
  const dur = days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"}`;

  return (
    <StatusLine tone={tone} actions={canMove && (
      <button className={`btn sm${isMine ? "" : " accent"}`}
        onClick={() => window.dispatchEvent(new Event(QUEUE_EVENT))}>
        {isMine ? "Hand it on" : "Move it"}
      </button>
    )}>
      {isMine ? (
        <>
          Ours to move{days > 0 ? <> for <span className="fig">{dur}</span></> : <> — landed <span className="fig">today</span></>}
          {reason ? <> — {reason}</> : <>. Nobody is waiting on anyone else.</>}
        </>
      ) : (
        <>
          Waiting on <b>{holderName}</b>{reason ? <> — {reason}</> : null}.
          {" "}Theirs for <span className="fig">{dur}</span>, since {since}.
        </>
      )}
    </StatusLine>
  );
}
