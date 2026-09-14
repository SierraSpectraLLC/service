// The asset registry's reading of where a unit's owner stands.
//
// A unit has no stage of its own. It is a former client's unit because the
// company that owns it - or, for a unit installed in a system, the company
// that owns the SYSTEM - is a former client. The system decides when there is
// one: the unit follows the machine, which is how a pump in a former client's
// LC-MS reads as theirs even when the pump's own owner column was left blank
// when it was entered.
//
// The same rule the systems registry runs on (lib/systemRegistry.systemState),
// so the two pages hide the same companies' equipment by default. Pure.

import { stageOf, type OrgStage } from "@/lib/orgStage";

export function unitStage(
  unit: { ownerOrgId: number | null; instrumentId: number | null },
  systemOwner: (instrumentId: number) => number | null | undefined,
  orgStage: (orgId: number) => unknown,
): OrgStage {
  const owner = unit.instrumentId !== null ? systemOwner(unit.instrumentId) ?? null : unit.ownerOrgId;
  // Nobody's, or an owner the viewer cannot resolve: a client's, which keeps
  // the unit on the list - the safe direction, as everywhere in lib/orgStage.
  return owner === null ? "client" : stageOf(orgStage(owner));
}

/**
 * Whether a reading keeps this unit.
 *
 * No hold named means everything but a former client's - what a person means
 * by "all units" is the equipment of the companies they still work for or
 * are selling to, and a former client's is its own facet a click away. Naming
 * the hold shows only those.
 */
export function unitShown(stage: OrgStage, held: string): boolean {
  return held === "former" ? stage === "former" : stage !== "former";
}
