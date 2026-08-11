// Which frozen engagement records belong on an organization's shelf, and under
// which heading. Pure so the rule can be argued with in tests rather than by
// squinting at a dashboard.
//
// See db/schema engagementRecords for what mints one. The rule that matters:
// holding a record does NOT mean the system is gone. A reseller kept on as a
// viewer after a handoff holds a frozen copy of their tenure while the live
// system still sits on their board - showing both reads as the same system
// listed twice. Live wins; the record surfaces once the system leaves.

export type ShelvableRecord = { kind: string; instrumentId: number | null };

export type Shelves<T> = {
  /** A share was withdrawn: work you did for someone else, now closed. */
  pastEngagements: T[];
  /** You owned it and handed it on. */
  previouslyOwned: T[];
};

/**
 * `liveToMe` is the set of system ids currently on this viewer's dashboard.
 * A record whose system is gone entirely (FK nulled) always shelves - there is
 * no live row left for it to duplicate.
 */
export function shelveRecords<T extends ShelvableRecord>(records: T[], liveToMe: Set<number>): Shelves<T> {
  const frozen = records.filter((r) => r.instrumentId === null || !liveToMe.has(r.instrumentId));
  return {
    // Anything not explicitly a handoff reads as an ended engagement, which is
    // also what the pre-`kind` rows default to.
    pastEngagements: frozen.filter((r) => r.kind !== "handoff"),
    previouslyOwned: frozen.filter((r) => r.kind === "handoff"),
  };
}
