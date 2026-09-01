// Where a machine has been, as one list.
//
// The record kept two of these and they answered the same question from
// opposite ends. QUEUE says who is expected to make the next move; OWNERSHIP
// says whose machine it is. Both are "who has this thing", both are written
// one leg at a time, and both were drawn as their own card with their own
// heading and their own chronology - so the story of a system that arrived on
// loan, was worked, went back, and was later bought outright was told twice,
// in two places, neither of which was in order.
//
// One chronology, two axes. A move between queues and a change of owner are
// different KINDS of event, not different histories, and reading them
// interleaved is how anybody actually reconstructs what happened: the handoff
// on the 12th makes sense of the queue move on the 11th, and the two cards
// made you hold one date in your head while you scrolled to the other.
//
// Pure so the ordering is testable without a page. The formatting is done by
// the caller - `when` arrives already rendered in shop time, because this file
// has no business knowing what timezone the shop is in.

/** A move between queues: who is expected to act changed. */
export type QueueLeg = {
  id: number;
  fromName: string;
  toName: string;
  /** What they were told they are waiting on, in the words whoever parked it used. */
  reason: string;
  actor: string;
  /** For sorting. */
  at: Date;
  /** For display, already in shop time. */
  when: string;
};

/** A change of owner: whose machine it is changed. */
export type OwnerEvent = {
  id: number;
  /** intake | transfer | claim | release - see KIND_WORD in CustodyPanel. */
  kind: string;
  fromName: string;
  toName: string;
  note: string;
  actor: string;
  at: Date;
  when: string;
};

export type CustodyEntry = {
  /** Unique across both axes - the two id spaces overlap. */
  key: string;
  axis: "queue" | "owner";
  /** intake/transfer/claim/release for owner rows; empty for queue legs. */
  kind: string;
  fromName: string;
  toName: string;
  /** The reason or the note, whichever this axis calls it. */
  note: string;
  actor: string;
  when: string;
  at: Date;
};

/**
 * Both axes, newest first.
 *
 * Ties go to the OWNER row. A handoff writes both a custody event and a queue
 * leg in the same transaction, so their timestamps land equal often enough to
 * matter, and "Sierra Spectra → Modesto" followed by "moved into Modesto's
 * queue" reads as cause then effect. The other order reads as two unrelated
 * things that happened to share a second.
 */
export function custodyLine(queue: QueueLeg[], owner: OwnerEvent[]): CustodyEntry[] {
  const rows: CustodyEntry[] = [
    ...owner.map((o) => ({
      key: `own-${o.id}`, axis: "owner" as const, kind: o.kind,
      fromName: o.fromName, toName: o.toName, note: o.note,
      actor: o.actor, when: o.when, at: o.at,
    })),
    ...queue.map((q) => ({
      key: `q-${q.id}`, axis: "queue" as const, kind: "",
      fromName: q.fromName, toName: q.toName, note: q.reason,
      actor: q.actor, when: q.when, at: q.at,
    })),
  ];
  return rows.sort((a, b) => {
    const d = b.at.getTime() - a.at.getTime();
    if (d !== 0) return d;
    if (a.axis !== b.axis) return a.axis === "owner" ? -1 : 1;
    // Same axis, same instant: the later id happened later. Without this two
    // rows written in one transaction come back in whatever order the query
    // felt like, which makes the panel flicker between deploys.
    return b.key.localeCompare(a.key);
  });
}
