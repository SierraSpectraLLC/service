// Whose block is it.
//
// A block has always carried three facts: that work has stopped, why, and
// since when. It never carried the fourth, and the fourth is the one a morning
// stand-up actually sorts by - WHOSE it is. lib/digest filled the gap by
// hardcoding "us" on every block ever recorded, which is right most of the
// time and wrong in a way nobody could correct.
//
// THE REASON IS NOT THE HOLDER. This is the whole design, and it is the same
// mistake the queue made in another costume: "waiting on LabZen to approve the
// quote" names who we are waiting ON, and the app read that as who the wait
// belonged TO. It does not. The machine is on our bench, the chase is ours,
// the customer is not the one who has to look at a list every morning and do
// something about it. A block moves to another organization when the PROBLEM
// is theirs to hold - their unit, their bench, their decision to own - not
// because their name appears in the sentence.
//
// Pure, because the answer shows up in four places - the record, the board,
// the roster and both digest editions - and a second copy of this rule is a
// morning list that disagrees with the page it links to.

/** A block's court, in the digest's vocabulary. See lib/digest.Court. */
export type BlockSide = "us" | "partner";

/**
 * The organization a block falls under, resolved.
 *
 * Null on the row is the operator, and deliberately so: it is what every block
 * recorded before this column existed means, and it is exactly what the
 * hardcoded answer said about them. Reading null as "unknown" would turn a
 * year of ordinary bench blocks into a year of missing data.
 */
export const blockOrgId = (
  blockedOrgId: number | null,
  operatorOrgId: number | null,
): number | null => blockedOrgId ?? operatorOrgId;

/** Is this block ours, from the point of view of one engagement's section? */
export function blockSide(
  blockedOrgId: number | null,
  sectionOrgId: number | null,
  operatorOrgId: number | null,
): BlockSide {
  const held = blockOrgId(blockedOrgId, operatorOrgId);
  // A section for the operator's own bench has no partner to hand it to.
  if (sectionOrgId === null) return "us";
  return held !== null && held === sectionOrgId ? "partner" : "us";
}

/**
 * Who to name beside a block, or "" when it is the obvious party.
 *
 * Silence where it is ours is not an omission: this line already sits on the
 * operator's own board, under the operator's own header, and "Blocked with
 * Sierra Spectra" on a Sierra Spectra screen is the frame the coverage summary
 * had to lose for the same reason. The name earns its place only when the
 * answer is somebody else.
 */
export function blockHolderName(
  blockedOrgId: number | null,
  operatorOrgId: number | null,
  orgName: (id: number | null) => string,
): string {
  const held = blockOrgId(blockedOrgId, operatorOrgId);
  if (held === null || held === operatorOrgId) return "";
  return orgName(held);
}

/**
 * The sentence under the blocked pill.
 *
 * "Blocked" alone where it is ours; "Blocked with Coastal Analytical" where it
 * is not - never "blocked BY", which reads as blame for a state that is
 * usually nobody's fault.
 */
export const blockLabel = (holder: string): string =>
  holder ? `Blocked with ${holder}` : "Blocked";

/** One organization a block may be put under. */
export type BlockOrgChoice = { id: number; name: string; note: string };

/**
 * Which organizations this system's block may be put under, best first.
 *
 * Three parties can genuinely hold a block on one machine: the shop working
 * it, the organization that owns it, and anyone it has been shared with to
 * work on. Nobody else - a picker that listed the whole instance would let a
 * block be parked on a company with no connection to the system, and on a
 * multi-operator instance it would also hand over the client list.
 *
 * The blocker's own organization sorts first because it is the default and the
 * common case: if we are working on a system and block it, it is blocked with
 * us, whoever the reason happens to name.
 */
export function blockOrgChoices(
  parties: { id: number; name: string; note: string }[],
  viewerOrgId: number | null,
): BlockOrgChoice[] {
  const seen = new Set<number>();
  const out: BlockOrgChoice[] = [];
  for (const p of parties) {
    if (p.id <= 0 || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
  }
  return out.sort((a, b) =>
    (a.id === viewerOrgId ? 0 : 1) - (b.id === viewerOrgId ? 0 : 1));
}
