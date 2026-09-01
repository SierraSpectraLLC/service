"use client";

import { useTransition } from "react";
import { ackQueueHandback } from "@/app/actions";
import { QUEUE_EVENT } from "@/components/CustodyPanel";
import StatusLine from "@/components/ui/StatusLine";
import { toast } from "@/components/ui/Toast";
import { standingTone } from "@/lib/panelMode";

/**
 * Whose move it is, in one sentence, above everything else on the record.
 *
 * The question this answers is "why is nothing happening on this machine",
 * and the banded page made you scroll past four cards to the Custody panel to
 * find it. A system parked with a client for three weeks looked exactly like one
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
  instrumentId, holderName, isMine, days, since, reason, canMove, overdue,
  clientVoice = false, pending = true, dismissible = false,
}: {
  instrumentId: number;
  /** Who holds the queue right now, already resolved to a name. */
  holderName: string;
  /** True when the viewer HOLDS it - not necessarily that they owe a move. */
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
  /**
   * Say it in the client's words rather than the shop's.
   *
   * queueView() is viewer-relative, so "mine" already means the client here -
   * but the sentences were not. A client reading their own machine was told
   * "Ours to move for 8 days" with a button marked "Hand it on", which is the
   * shop talking to itself with the client standing in the room.
   */
  clientVoice?: boolean;
  /**
   * Whether anything is actually pending on it - an open job, work that has
   * stopped, maintenance fallen due.
   *
   * Holding a system is a POSITION; owing a move is an OBLIGATION, and the two
   * are not the same fact. A shop that finishes a job hands the system back,
   * and the queue arrives at the client with nothing attached to it. See
   * queueNeedsThem in lib/clientView.
   */
  pending?: boolean;
  /**
   * This one is a notification rather than a standing fact, so it comes with a
   * way to close it.
   *
   * "Back with you since Tuesday, nothing is pending on it" earns the top of
   * the record once. Left there it becomes furniture, and furniture at the top
   * of a record teaches people to skip the top of the record - which is where
   * the line that DOES matter appears next time. See ackQueueHandback, which
   * also records the dismissal, so a handback nobody read shows as unread.
   */
  dismissible?: boolean;
}) {
  const [busy, start] = useTransition();
  // The same rule the page sets data-tone by on its root - one function, so
  // this line and the pane's rack spine can never disagree.
  const tone = standingTone({ isMine, overdue });
  const dur = days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"}`;

  const dismiss = () => start(async () => {
    const res = await ackQueueHandback(instrumentId);
    if (res?.error) toast({ message: res.error, tone: "bad" });
  });

  return (
    <StatusLine tone={tone} actions={dismissible ? (
      /* Not "Hand it back": nothing is pending, so there is nothing to hand
         back. The only thing left to do with this sentence is finish reading
         it. Moving it is still one card down, on the Custody panel, along
         with every fact this line is repeating. */
      <button className="btn sm" onClick={dismiss} disabled={busy}>
        {busy ? "Dismissing…" : "Dismiss"}
      </button>
    ) : canMove && !(isMine && clientVoice) && (
      /* No button when the system is already THEIRS.
         "Hand it back" was the shop's verb pointed at the machine's owner:
         it is in their lab, it is their instrument, and there is nowhere to
         hand it. What a client actually wants from here is service, and
         Request service is on the record's header where it always was. The
         queue is still movable on the Custody panel for anybody who genuinely
         means to send it in - it says "Move it" and names both ends,
         which is the honest version of this button. */
      <button className={`btn sm${isMine ? "" : " accent"}`}
        onClick={() => window.dispatchEvent(new Event(QUEUE_EVENT))}>
        {isMine ? "Hand it on" : "Move it"}
      </button>
    )}>
      {isMine && clientVoice && !pending ? (
        /* Theirs, and nothing is pending on it - the ordinary way a system
           ends up back with its owner after a job is finished. Announcing that
           as a chore is what turned "we finished your maintenance" into
           "Sierra Spectra is waiting on you". */
        <>
          Back with you since {since}{days > 0 ? <>, <span className="fig">{dur}</span> ago</> : null}
          {reason ? <> — {reason}</> : null}. Nothing is pending on it.
        </>
      ) : isMine && clientVoice ? (
        <>
          Your move{days > 0 ? <> for <span className="fig">{dur}</span></> : <> — landed <span className="fig">today</span></>}
          {reason ? <> — {reason}</> : <>. It is with you, not with {holderName}.</>}
        </>
      ) : isMine ? (
        <>
          Ours to move{days > 0 ? <> for <span className="fig">{dur}</span></> : <> — landed <span className="fig">today</span></>}
          {reason ? <> — {reason}</> : <>. Nobody is waiting on anyone else.</>}
        </>
      ) : clientVoice ? (
        <>
          With <b>{holderName}</b>{reason ? <> — {reason}</> : null}.
          {" "}Theirs for <span className="fig">{dur}</span>, since {since}.
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
