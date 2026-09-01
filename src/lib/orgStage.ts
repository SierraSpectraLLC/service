// Where we stand with a company, as one word.
//
// This started as orgs.prospect, a boolean, for one problem: quoting a company
// means creating it and its systems, and those systems then joined the working
// fleet. One quote to a stranger put their machines on the board, in the
// metrics and on the maintenance calendar, and the shop had no way to say "not
// ours yet" short of not recording them at all.
//
// The boolean was the right shape for exactly one question and the wrong shape
// for the next one, which arrived as: "I also want a 'former client' option.
// That way I can remove their systems from the active queue like a prospect,
// update any information I receive about their system and keep provenance
// records / ship those records to other orgs."
//
// That is a THIRD state, not the negation of either existing one. A former
// client is not a prospect - nothing is being sold, and calling the record a
// sales lead would put it back in front of whoever works the pipeline. And a
// former client is not a client - their machines are not the shop's week any
// more. What the two share is the only rule either one has ever had:
//
//   NOT IN THE WORKING FLEET, EVERYTHING ELSE INTACT.
//
// The record stays complete on both sides of the line. The systems are still
// on the company's own page, still in search, still in the coverage picker,
// still carrying their whole service history - which for a former client is
// the entire point, because that history is what gets handed to whoever owns
// the machine next. See lib/custodyLine and handOffSystem for how it travels.
//
// Orthogonal to orgs.kind, which says which SIDE of the relationship a company
// is on (client or provider) and is load-bearing for personas, sharing and the
// provider queue. A prospect is still a client-kind org; so is a former one.

export const ORG_STAGES = ["client", "prospect", "former"] as const;
export type OrgStage = (typeof ORG_STAGES)[number];

export const isOrgStage = (v: unknown): v is OrgStage =>
  typeof v === "string" && (ORG_STAGES as readonly string[]).includes(v);

/**
 * Anything unrecognized is a client.
 *
 * Every row that existed before the column did reads as one, which is the
 * point: an organization already on file is a client until somebody says
 * otherwise. A future stage read by an older deploy lands here too, which is
 * the safe direction - it puts a machine back on the board rather than
 * silently dropping it off.
 */
export const stageOf = (v: unknown): OrgStage => (isOrgStage(v) ? v : "client");

/** The word for a person, not the word for the column. */
export const STAGE_WORD: Record<OrgStage, string> = {
  client: "client",
  prospect: "prospect",
  former: "former client",
};

/**
 * The tone the stage pill carries.
 *
 * Amber for a prospect because it is a live question somebody is working;
 * neutral for a former client because it is settled, and there is nothing to
 * chase. Nothing here is bad - a company that stopped buying is a fact about
 * the past, not a fault, and colouring it red would be the roster editorializing.
 */
export const STAGE_TONE: Record<OrgStage, "good" | "warn" | "neutral"> = {
  client: "good",
  prospect: "warn",
  former: "neutral",
};

/**
 * Whether this company's systems are part of what the shop looks after.
 *
 * The one rule, asked once. Both non-client stages are held out and for the
 * same reason - the fleet is what the shop is working THIS WEEK - which is why
 * this is a function over the stage rather than two comparisons written out at
 * each call site.
 */
export const heldOutOfFleet = (stage: unknown): boolean => stageOf(stage) !== "client";

/**
 * The stages the fleet holds back, as values for a SQL `IN`.
 *
 * Named rather than written as `<> 'client'` so the database and stageOf()
 * cannot disagree about a value neither expected. They did, briefly, and the
 * test caught it: an empty string is a client to stageOf and was NOT a client
 * to `<>`, so a row nobody had set would have had its machines quietly taken
 * off the board.
 *
 * Listing what is held rather than what is not also picks the safe direction
 * for a stage this deploy has never heard of - a machine stays visible instead
 * of vanishing, which is the failure a shop can see.
 */
export const HELD_STAGES: OrgStage[] = ORG_STAGES.filter((s) => s !== "client");

/**
 * What the org page says about the consequence, in the stage's own terms.
 *
 * Written here rather than in the form so the three readings stay parallel and
 * so nobody has to reconstruct the rule from a ternary. `systems` is how many
 * they own, because "held out of the fleet" is abstract until it is a number.
 */
export function stageHint(stage: OrgStage, name: string, systems: number): string {
  const theirs = systems === 1 ? "system is" : "systems are";
  switch (stage) {
    case "prospect":
      return `We are selling to ${name}. Their ${theirs} on file and on their own page, and stay off the board, the metrics and the maintenance calendar until they are a client.`;
    case "former":
      return `${name} used to be a client. Their ${theirs} still on file with the whole service history - which is what gets handed on when a machine changes hands - and stay off the board, the metrics and the maintenance calendar.`;
    default:
      return `${name} is a client. Everything of theirs is in the working fleet.`;
  }
}
