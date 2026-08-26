// The organizations with a real hold on one system.
//
// Two features now need the same list and the same rule. A BLOCK falls under
// one of them (lib/blocks); a part somebody is fabricating is being MADE by
// one of them (lib/stages). Both are the same question - which companies are
// actually involved with this machine - and both have the same wrong answer
// available: every organization on the instance.
//
// That wrong answer is worth naming, because a picker is where it would get
// made. Offering the whole instance lets a block be parked, or a part
// attributed, to a company with no connection to the system - somewhere nobody
// would ever look for it - and on a multi-operator instance the list itself
// hands one shop its competitor's client book.
//
// Pure. lib/partyData reads the rows.

/** One organization, and why it is on the list. */
export type PartyChoice = {
  id: number;
  name: string;
  /**
   * What this org is to the system: "working it", "owns it", "shared with".
   *
   * Not decoration. On a shared bench two of the three can be the same kind of
   * company, and the names alone do not say which one owns the machine.
   */
  note: string;
};

/**
 * The parties, deduplicated, with the asker's own organization first.
 *
 * First because it is the default and the common case, whichever feature is
 * asking: if we are working on a system and block it, it is blocked with us;
 * if we are the ones at the printer, we are the ones making it.
 *
 * A duplicate keeps its FIRST note, so a shop that owns the machine it is
 * working reads as "working it" rather than appearing twice.
 */
export function partyChoices(
  parties: { id: number; name: string; note: string }[],
  viewerOrgId: number | null,
): PartyChoice[] {
  const seen = new Set<number>();
  const out: PartyChoice[] = [];
  for (const p of parties) {
    if (p.id <= 0 || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out.sort((a, b) =>
    (a.id === viewerOrgId ? 0 : 1) - (b.id === viewerOrgId ? 0 : 1));
}
