// Who sees what of a machine's history. One function, no I/O, no database.
//
// This module exists because the alternative was discovered the expensive way in
// every other visibility question this codebase has: lib/tenants stamps, lib/redact
// filters costs, lib/dossier scopes to an org, lib/serialLookup has its own
// disclosure rules, and system_shares decides access - five answers to one
// question, each correct on the surface it was written for and none of them
// checkable against the others. A machine outlives every one of those surfaces.
// Custody gets ONE answer, written before the schema so the schema can be built
// to serve it, and asserted as a truth table in tests/custodyView.test.ts.
//
// The rules are in docs/adr/0001-custody-and-provenance.md. In one paragraph:
// a viewer is a PARTY to an epoch if it held the machine, was granted access to
// it (ever), brokered its close, or authored, commissioned or held the machine
// for any event in it. Parties see everything of that epoch. The highest epoch a
// viewer is party to is its ANCHOR, and everything below the anchor reads as
// provenance - that is what a buyer is buying. Everything above it that they are
// not party to is closed. A viewer who is party to nothing gets an empty view,
// not a list of locked doors: the machine does not exist for them.

import {
  type Epoch, type EpochLevel, type Grant, type LevelReason, type OrgId, type OrgRef,
  type ProcedureKeyEntry, type SystemChain, type SystemEvent, partyLabel,
} from "@/lib/custody/types";

/**
 * Shown IN PLACE of withheld free text, never instead of the fact that text
 * exists. A redaction that hides its own existence is a lie about the record,
 * and the whole value of the chain is that it does not lie.
 */
export const WITHHELD_MARKER = "Findings withheld before this record traveled.";

const add = (set: Set<OrgId>, id: OrgId | null | undefined) => {
  if (id !== null && id !== undefined) set.add(id);
};

/**
 * Everyone who was in the room for one event: whoever did the work, whoever
 * asked for it, and whoever held the machine while it happened. These three are
 * the private payload's audience, and they are narrower than the epoch - a
 * broker who commissioned one exam is a party to that exam and not to the PM
 * that ran the week before.
 */
export function eventParties(event: SystemEvent): Set<OrgId> {
  const out = new Set<OrgId>();
  add(out, event.authorOrgId);
  add(out, event.commissionerOrgId);
  add(out, event.custodianOrgId);
  return out;
}

/**
 * Everyone with standing in one span of custody.
 *
 * Grants count whether or not they are still live. Ending a grant must not erase
 * the grantee's view of the work the grantee itself did: revoking a provider is
 * a decision about future access, and reading it as "and now you cannot see your
 * own service records" would make revocation unusable and the record unreliable
 * at the same time.
 */
export function epochParties(epoch: Epoch, events: SystemEvent[], grants: Grant[]): Set<OrgId> {
  const out = new Set<OrgId>();
  add(out, epoch.custodianOrgId);
  add(out, epoch.brokerOrgId);
  for (const g of grants) if (g.epochId === epoch.id) add(out, g.granteeOrgId);
  for (const e of events) {
    if (e.epochId !== epoch.id) continue;
    for (const id of eventParties(e)) out.add(id);
  }
  return out;
}

/** The strongest role a viewer holds in an epoch, or null if it holds none. */
function partyReason(viewerOrgId: OrgId, epoch: Epoch, chain: SystemChain): LevelReason | null {
  if (epoch.custodianOrgId === viewerOrgId) return "custodian";
  if (epoch.brokerOrgId === viewerOrgId) return "broker";
  if (chain.grants.some((g) => g.epochId === epoch.id && g.granteeOrgId === viewerOrgId)) return "grantee";
  const mine = chain.events.filter((e) => e.epochId === epoch.id);
  if (mine.some((e) => e.commissionerOrgId === viewerOrgId)) return "commissioner";
  if (mine.some((e) => e.authorOrgId === viewerOrgId)) return "author";
  if (mine.some((e) => e.custodianOrgId === viewerOrgId)) return "custodian_at_time";
  return null;
}

export function isParty(viewerOrgId: OrgId | null, epoch: Epoch, chain: SystemChain): boolean {
  return viewerOrgId !== null && partyReason(viewerOrgId, epoch, chain) !== null;
}

/**
 * The highest epoch number the viewer is a party to; 0 for a stranger.
 *
 * A LATER grant reaches backwards: a provider brought in on epoch 3 can read
 * epochs 1 and 2 as provenance, because that is the question they were brought
 * in to answer ("what has been done to this thing"). It never reaches forwards.
 */
export function anchor(viewerOrgId: OrgId | null, chain: SystemChain): number {
  if (viewerOrgId === null) return 0;
  let best = 0;
  for (const epoch of chain.epochs) {
    if (epoch.n > best && partyReason(viewerOrgId, epoch, chain) !== null) best = epoch.n;
  }
  return best;
}

export function levelOf(viewerOrgId: OrgId | null, epoch: Epoch, chain: SystemChain): EpochLevel {
  if (viewerOrgId === null) return "none";
  if (partyReason(viewerOrgId, epoch, chain) !== null) return "full";
  return epoch.n < anchor(viewerOrgId, chain) ? "prov" : "none";
}

/** One epoch as one viewer gets it. `reason` is a tooltip, and an assertion in tests. */
export type EpochView = { epoch: Epoch; level: EpochLevel; reason: LevelReason };

/**
 * THE function. Every custody read path goes through it - Phase 3's loader calls
 * it with rows, tests call it with fixtures, and no surface is allowed its own
 * copy of these rules.
 *
 * An empty `epochs` is not an error and not the same as a list of `none`: a
 * viewer with no relationship to a machine is told nothing about it, including
 * how many times it has changed hands. `viewerOrgId` accepts null for the public
 * listing case, which Phase 8 gives its own rule; until then null is a stranger.
 */
export function viewOf(viewerOrgId: OrgId | null, chain: SystemChain): { epochs: EpochView[] } {
  const a = anchor(viewerOrgId, chain);
  if (a === 0) return { epochs: [] };
  const epochs = [...chain.epochs].sort((x, y) => x.n - y.n).map((epoch) => {
    const reason = partyReason(viewerOrgId as OrgId, epoch, chain);
    if (reason) return { epoch, level: "full" as const, reason };
    return epoch.n < a
      ? { epoch, level: "prov" as const, reason: "below_anchor" as const }
      : { epoch, level: "none" as const, reason: "after_last_involvement" as const };
  });
  return { epochs };
}

/** One event as one viewer gets it. Null payloads mean "not visible", not "empty". */
export type EventView = {
  eventId: number;
  level: EpochLevel;
  procedureKeys: ProcedureKeyEntry[] | null;
  provenance: (Record<string, unknown> & { findings?: string }) | null;
  private: Record<string, unknown> | null;
  /** True whenever text was held back, to parties and strangers alike. */
  withheldDownstream: boolean;
};

/**
 * Shown in place of free text that a claim has not yet released. Different
 * words from WITHHELD_MARKER on purpose: one says the author held it back,
 * the other says the clock has not run - and the reader is owed the
 * difference, because one of them ends.
 */
export const EMBARGOED_MARKER = "Findings held until the claim's notice window ends.";

export function eventVisibility(
  viewerOrgId: OrgId | null, event: SystemEvent, epoch: Epoch, chain: SystemChain, now: Date = new Date(),
): EventView {
  const level = levelOf(viewerOrgId, epoch, chain);
  const onEvent = viewerOrgId !== null && eventParties(event).has(viewerOrgId);
  // Spelled out rather than folded into `onEvent`: the epoch's custodian is
  // normally the event's custodian-at-time too, but an event recorded across a
  // custody boundary is exactly the case where the two differ, and the holder of
  // the span does not lose sight of work done during it on a timestamp.
  const seesPrivate = onEvent || (viewerOrgId !== null && epoch.custodianOrgId === viewerOrgId);

  if (level === "none") {
    return { eventId: event.id, level, procedureKeys: null, provenance: null, private: null, withheldDownstream: false };
  }

  let provenance: Record<string, unknown> & { findings?: string } = { ...event.provenance };
  if (event.withheld && !onEvent) provenance = { ...provenance, findings: WITHHELD_MARKER };
  // A claimed tenure releases its free text on a clock, to everyone who is not
  // a party to the line - the claimant included. Structured fields never wait.
  else if (!onEvent && epoch.findingsEmbargoUntil && now < epoch.findingsEmbargoUntil && typeof provenance.findings === "string") {
    provenance = { ...provenance, findings: EMBARGOED_MARKER };
  }

  return {
    eventId: event.id,
    level,
    procedureKeys: event.procedureKeys,
    provenance,
    private: seesPrivate ? event.private : null,
    withheldDownstream: event.withheld,
  };
}

/**
 * What the holder of an epoch is called. Anonymous below `full` because the
 * custodian chain is the part a competitor would pay for: "who else has been
 * buying these" is a customer list, and it is not the machine's history.
 */
export function custodianLabel(
  viewerOrgId: OrgId | null, epoch: Epoch, org: OrgRef, chain: SystemChain,
): string {
  return levelOf(viewerOrgId, epoch, chain) === "full"
    ? org.name
    : `${partyLabel(org.kind)}, anonymized`;
}

/**
 * What the author of an event is called.
 *
 * A service provider's name travelling downstream is free advertising for a
 * national and a re-identification for a shop that works four instruments in one
 * county, so it is opt-in and the provider owns the switch. Work the custodian
 * did on its own machine reads as "custodian at the time" instead - naming the
 * author there would undo the custodian anonymization one line lower.
 */
export function authorLabel(
  viewerOrgId: OrgId | null, event: SystemEvent, org: OrgRef, level: EpochLevel,
): string {
  const withheldName = `${partyLabel(org.kind)} (name withheld by provider)`;
  if (viewerOrgId !== null && eventParties(event).has(viewerOrgId)) return org.name;
  if (level === "full") return org.name;
  if (level === "none") return withheldName;
  if (event.authorOrgId === event.custodianOrgId) return "custodian at the time";
  return org.showNameDownstream ? org.name : withheldName;
}
