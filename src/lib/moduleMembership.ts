// Where a unit stood on a given day, read back from its move log.
//
// A unit's daily updates are kept on the unit, so they travel with it when it
// is pulled out of one system and put into another - that is the point. But
// the system it was in at the time still has a claim on those lines: the
// refurbishment of O-004's detector happened IN O-004, whatever the detector
// is in now. So the system page and the day's report need to know, for a
// past day, which units were in which system THEN.
//
// Nothing records that directly. asset_events records each move as one row
// with one system column (see db/schema.assetEvents and actions.logAssetEvent):
//
//   installed  - joined `instrumentId` from the shelf
//   removed    - left `instrumentId` for the shelf
//   moved      - joined `instrumentId`; the system LEFT is only in the free
//                text, "MSP-004 -> MSP-007", or "spare" for the shelf
//   status     - a status change while on `instrumentId`; a decommission is
//                the one that also leaves it ("... -> Decommissioned")
//   note       - says nothing about position
//
// So position on day D is found by starting from where the unit is NOW and
// undoing every event after D, newest first. Pure: the caller supplies the
// events with their shop day and a way to turn a system's external id back
// into its row id for the moved-from text.

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

/** Turns the external id in a moved-from text into the system's row id, or null if unknown. */
export type FromIdOf = (externalId: string) => number | null;

const DECOMMISSIONED = /-> Decommissioned$/;

/**
 * The system a moved event's text says the unit came FROM. "spare" is the
 * shelf; a name the caller cannot resolve (a system since renamed or deleted)
 * reads as the shelf too - the safe direction, since it puts the unit's
 * lines under no system rather than the wrong one.
 */
export function movedFrom(detail: string, fromIdOf: FromIdOf): number | null {
  const i = detail.indexOf(" -> ");
  if (i < 0) return null;
  const from = detail.slice(0, i).trim();
  if (!from || from === "spare") return null;
  return fromIdOf(from);
}

/** The system an event says the unit LEFT, or null when it is not a leaving. */
export function leftSystemIn(e: MoveEvent, fromIdOf: FromIdOf): number | null {
  if (e.kind === "removed") return e.instrumentId;
  if (e.kind === "moved") return movedFrom(e.detail, fromIdOf);
  if (e.kind === "status" && DECOMMISSIONED.test(e.detail)) return e.instrumentId;
  return null;
}

/**
 * Where the unit stood at the END of `day`: start from where it stands now
 * and undo, newest first, every event that happened after that day.
 */
export function positionAtEndOf(
  day: string, current: number | null, events: MoveEvent[], fromIdOf: FromIdOf,
): number | null {
  let pos = current;
  const later = events.filter((e) => e.day > day).sort((a, b) => b.at - a.at);
  for (const e of later) {
    if (e.kind === "installed") pos = null;
    else if (e.kind === "removed") pos = e.instrumentId;
    else if (e.kind === "moved") pos = movedFrom(e.detail, fromIdOf);
    // A status event is stamped with the system the unit was on at that
    // instant - so before it, the unit was there. That covers a decommission
    // too, which stamps the system it left.
    else if (e.kind === "status") pos = e.instrumentId;
  }
  return pos;
}

/**
 * Was the unit in `systemId` at any point during `day` - there at the end of
 * it, or there until it left that day? A detector pulled on Tuesday afternoon
 * was still Tuesday's detector.
 */
export function wasInSystemOn(
  day: string, systemId: number, current: number | null, events: MoveEvent[], fromIdOf: FromIdOf,
): boolean {
  if (positionAtEndOf(day, current, events, fromIdOf) === systemId) return true;
  return events.some((e) => e.day === day && leftSystemIn(e, fromIdOf) === systemId);
}

/**
 * The last day the unit left `systemId`, for "was in this system until
 * Tuesday" - or null when it never has, or is there now.
 */
export function leftSystemOn(
  systemId: number, current: number | null, events: MoveEvent[], fromIdOf: FromIdOf,
): string | null {
  if (current === systemId) return null;
  const days = events.filter((e) => leftSystemIn(e, fromIdOf) === systemId).map((e) => e.day).sort();
  return days.length ? days[days.length - 1] : null;
}
