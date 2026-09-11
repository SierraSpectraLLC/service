// Where a unit stood on a given day, read back from its move log.
//
// A unit's daily updates are kept on the unit, so they travel with it when it
// is pulled out of one system and put into another - that is the point. But
// the system it was in at the time still has a claim on those lines: the
// refurbishment of O-004's detector happened IN O-004, whatever the detector
// is in now. So the system page, the day's report and the digest need to
// know, for a past day, which system a unit was in THEN.
//
// Nothing records that directly. asset_events records each move as one row
// with one system column (see db/schema.assetEvents and actions.logAssetEvent):
//
//   installed  - joined `instrumentId` from the shelf
//   removed    - left `instrumentId` for the shelf
//   moved      - joined `instrumentId`; the system LEFT is only in free text
//   status     - a status change while on `instrumentId`; a decommission is
//                the one that also leaves it ("... -> Decommissioned")
//   note       - says nothing about position
//
// The log is read FORWARD into a timeline of what each event says the unit's
// position was before and after it. The system a move LEFT is the position
// after the event before it - the unit's own log says so - and never the
// free text: a system can be renamed or deleted, and its tag handed to a new
// system anywhere on the instance, so a name resolved at read time is either
// nothing or the wrong system. A move with no earlier event reads as from
// the shelf, which files those lines under no system rather than a wrong one.
//
// Pure: the caller supplies the events with their shop day.

export type MoveEvent = {
  assetId: number;
  kind: string;
  instrumentId: number | null;
  detail: string;
  /** The shop calendar day the event fell on, YYYY-MM-DD. */
  day: string;
  /** Epoch ms, to order events within a day. */
  at: number;
};

/** One position-bearing event: where the unit was before it and after it. */
export type Step = { day: string; at: number; before: number | null; after: number | null };

const DECOMMISSIONED = /-> Decommissioned$/;

/** The unit's positions through its log, oldest first. */
export function timelineOf(events: MoveEvent[]): Step[] {
  const steps: Step[] = [];
  let pos: number | null | undefined; // unknown until an event says
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    let before: number | null;
    let after: number | null;
    if (e.kind === "installed") { before = null; after = e.instrumentId; }
    else if (e.kind === "removed") { before = e.instrumentId; after = null; }
    else if (e.kind === "moved") { before = pos === undefined ? null : pos; after = e.instrumentId; }
    else if (e.kind === "status") { before = e.instrumentId; after = DECOMMISSIONED.test(e.detail) ? null : e.instrumentId; }
    else continue;
    steps.push({ day: e.day, at: e.at, before, after });
    pos = after;
  }
  return steps;
}

/**
 * Where the unit stood at the END of `day`. After its last recorded event
 * the record itself answers - where the unit is now - which also absorbs a
 * change the log never saw, such as a system deleted from under it.
 */
export function positionAtEndOf(day: string, current: number | null, steps: Step[]): number | null {
  if (!steps.length || day >= steps[steps.length - 1].day) return current;
  const last = [...steps].reverse().find((s) => s.day <= day);
  return last ? last.after : steps[0].before;
}

/** Where the unit stood as `day` began: the position after the last event before it. */
export function positionAtStartOf(day: string, current: number | null, steps: Step[]): number | null {
  if (!steps.length || day > steps[steps.length - 1].day) return current;
  const last = [...steps].reverse().find((s) => s.day < day);
  return last ? last.after : steps[0].before;
}

/**
 * THE ONE RULE for which system a unit's line for `day` belongs to: the
 * system the unit was in when the day began, or, from the shelf, the one it
 * joined that day. A detector pulled out of MSP-004 on Tuesday afternoon was
 * still Tuesday's detector for MSP-004 - the work was done there - and the
 * line is filed once, so no system reads it twice.
 */
export function homeOn(day: string, current: number | null, steps: Step[]): number | null {
  return positionAtStartOf(day, current, steps) ?? positionAtEndOf(day, current, steps);
}

/**
 * The day the unit left `systemId`, on or after `day` - for "was in this
 * system until Tuesday" on a line whose home that day was the system. Null
 * while it is still there, or when the log never saw it leave.
 */
export function leftAfter(day: string, systemId: number, steps: Step[]): string | null {
  const step = steps.find((s) => s.day >= day && s.before === systemId && s.after !== systemId);
  return step ? step.day : null;
}
