// The shapes custody is stored in, written down before any of it is stored.
//
// Phase 0 has no database. These are plain objects on purpose: the visibility
// rules in ./view.ts are the part that must never be re-derived per surface, and
// the way to guarantee that is to make them testable as a table rather than
// discovered in production. Drizzle rows are assignable to these later; nothing
// here imports the schema, so client bundles and pure tests can hold them.
//
// See docs/adr/0001-custody-and-provenance.md for why each of these exists.
// System custody, NOT lib/provenance (catalog publishability), NOT
// lib/custodyLine (whose move it is), NOT lib/handoff (client-share invites).

export type OrgId = number;
export type EpochId = number;
export type EventId = number;
export type GrantId = number;
export type TransferId = number;

/**
 * WHO says a thing happened, and what that is worth.
 *
 * `attested` is the custodian asserting work they did not witness - a machine
 * bought with a binder. It is the weakest and it is still worth recording:
 * unrecorded history is not absent history, it is history that gets asserted
 * verbally at sale time with nothing behind it. `third_party` requires the
 * author org to be distinct from the custodian AND verified, because an org
 * grading its own subsidiary as third-party is the obvious way to game a score.
 */
export type WhoGrade = "attested" | "self_reported" | "third_party";

/**
 * HOW it was recorded. `procedure_run` means a procedure set was worked step by
 * step and left results; `typed` means somebody wrote it down afterwards;
 * `document_only` means a document exists and nothing structured does.
 *
 * lib/signoff.signoffGate already encodes the principle this axis generalizes:
 * a passing checkbox with no reading behind it is not evidence.
 */
export type HowGrade = "procedure_run" | "typed" | "document_only";

/**
 * How a custody epoch ENDED, as it reads to a later buyer. `dormant_gap` is the
 * one that has to exist: a holder who folds or ignores the notice leaves a hole,
 * and a chain that quietly closes over the hole is worse than one that shows it.
 */
export type HandoffGrade = "sealed" | "steward_sealed" | "dormant_gap" | "closed_by_claim";

/** As stored on the epoch. `open` is the live span; the rest map to a HandoffGrade. */
export type CloseKind = "open" | "sealed" | "steward_sealed" | "dormant" | "claimed";

export function handoffGradeOf(closeKind: CloseKind): HandoffGrade | null {
  switch (closeKind) {
    case "open": return null;
    case "sealed": return "sealed";
    case "steward_sealed": return "steward_sealed";
    case "dormant": return "dormant_gap";
    case "claimed": return "closed_by_claim";
  }
}

/**
 * What a viewer gets of one epoch.
 *
 * `full` is both payloads and real names. `prov` is the provenance payload only,
 * with custodians anonymized - what a buyer is buying. `none` is the epoch's
 * existence and nothing else: custody moving on does not hand the previous
 * holder a window into what happens next.
 */
export type EpochLevel = "full" | "prov" | "none";

/** Why a viewer got the level it got. Rendered as a tooltip; asserted in tests. */
export type LevelReason =
  | "custodian" | "broker" | "grantee" | "commissioner" | "author" | "custodian_at_time"
  | "below_anchor" | "after_last_involvement";

export type GrantKind = "service" | "broker" | "assessor" | "view";
export type GrantEndReason = "revoked" | "released" | "epoch_closed" | "expired";

export type EventKind =
  | "pm" | "repair" | "inspection" | "tune" | "qualification" | "config"
  | "intake" | "attested" | "transfer" | "claim" | "release" | "note";

export type SourceKind =
  | "work_order" | "task" | "pm_schedule" | "checkout_verdict" | "custody_event"
  | "manual" | "scan" | "backfill";

export type TransferStatus =
  | "initiated" | "reviewed" | "sealed" | "accepted" | "declined" | "cancelled";

/**
 * What an org IS to a reader of the chain, and therefore what it is called when
 * its name is withheld. Deliberately not orgs.kind: 'client' is a word about our
 * relationship to them, and it means nothing to somebody reading a machine's
 * history six years and three owners later.
 */
export type PartyKind = "lab" | "provider" | "reseller" | "broker" | "operator";

const PARTY_LABEL: Record<PartyKind, string> = {
  lab: "Lab",
  provider: "Service provider",
  reseller: "Reseller",
  broker: "Broker",
  operator: "Operator",
};

export const partyLabel = (kind: PartyKind): string => PARTY_LABEL[kind];

/** An org as the chain needs it. `name` is never rendered without asking view.ts. */
export type OrgRef = {
  id: OrgId;
  name: string;
  kind: PartyKind;
  /**
   * Opt-in, and off by default. A shop that services four instruments in one
   * county is identified by its own name appearing downstream even when the
   * custodian is anonymized, so this is the provider's decision and nobody
   * else's. See the open questions in ADR 0001.
   */
  showNameDownstream: boolean;
  /** Set by the platform. Null means this org cannot author a `third_party` grade. */
  verifiedAt: Date | null;
};

/** One span of custody. Exactly one epoch per instrument has closeKind 'open'. */
export type Epoch = {
  id: EpochId;
  instrumentId: number;
  /** 1-based, dense, per instrument. The anchor comparison is on this number. */
  n: number;
  /**
   * Null is HOUSE STEWARDSHIP - a machine the operator runs directly, or one a
   * provider logged before its real owner joined the platform. Widened from the
   * Phase 0 shape because instruments.owner_org_id has always been nullable and
   * has always meant this; an epoch model that could not express it would have
   * had to invent a custodian for every unclaimed system on the instance.
   * Nobody is ever a party to a null custodian - see view.epochParties.
   */
  custodianOrgId: OrgId | null;
  /**
   * The custodian's name as it stood. Kept as text beside the id for the reason
   * custody_events keeps fromName/toName: an org row can be deleted and a
   * custody record has to stay readable forever.
   */
  custodianName: string;
  openedByEventId: EventId | null;
  closedByEventId: EventId | null;
  closeKind: CloseKind;
  sealedAt: Date | null;
  sealHash: string | null;
  /** The broker on the transfer that CLOSED this epoch. A party to it, forever. */
  brokerOrgId: OrgId | null;
  /**
   * Claimed epochs only. Structured provenance crosses to the claimant at
   * once; free text crosses at this moment unless its author withheld it
   * during the notice window. Null = no embargo, which is every epoch that
   * closed any other way.
   */
  findingsEmbargoUntil?: Date | null;
};

export type Grant = {
  id: GrantId;
  instrumentId: number;
  epochId: EpochId;
  granteeOrgId: OrgId;
  grantedByOrgId: OrgId;
  kind: GrantKind;
  scope: Record<string, unknown>;
  startsAt: Date;
  endsAt: Date | null;
  /**
   * When it actually ended. A grant that has ended STILL HAPPENED: the org that
   * worked on the machine keeps its view of the epoch it worked in, because
   * taking that away would mean revoking a provider erases their own record of
   * their own work. Party-ness is historical, never current.
   */
  endedAt: Date | null;
  endedBy: OrgId | null;
  endReason: GrantEndReason | null;
};

/** One entry in an event's structured content. Travels; never withheld. */
export type ProcedureKeyEntry = {
  key: string;
  state: "done" | "skip" | "na";
  reading?: string;
  unit?: string;
  condition?: string;
  /** Why a step was skipped. Travels - "still due" is the next owner's problem. */
  reason?: string;
  partNumber?: string;
};

/**
 * One thing that happened to one machine.
 *
 * The two payloads are split HERE, at write, not filtered at read. The person
 * who knows whether a sentence may follow the machine to a stranger in 2031 is
 * the person typing it, and they will not be reachable later.
 */
export type SystemEvent = {
  id: EventId;
  instrumentId: number;
  assetId: number | null;
  /** Null only between the Phase 2 backfill and the Phase 3 epoch assignment. */
  epochId: EpochId | null;
  kind: EventKind;
  occurredAt: Date;
  recordedAt: Date;
  /** Null is the operator's own staff, who hold no org row of their own. */
  authorOrgId: OrgId | null;
  /** Who asked for the work. A broker commissioning an exam is a party to it. */
  commissionerOrgId: OrgId | null;
  /** Who held the machine at occurredAt. Not derived at read: custody moves. */
  custodianOrgId: OrgId | null;
  whoGrade: WhoGrade;
  howGrade: HowGrade;
  procedureKeys: ProcedureKeyEntry[];
  /** Travels forever. `findings` is the free-text field and the only withholdable one. */
  provenance: Record<string, unknown> & { findings?: string };
  /** Stays with the parties to this event. Never hashed, so redaction is safe. */
  private: Record<string, unknown>;
  /** Free text held back at seal, or by its author during a claim window. */
  withheld: boolean;
  sourceKind: SourceKind;
  sourceId: string | null;
  prevHash: string | null;
  hash: string | null;
};

export type Transfer = {
  id: TransferId;
  instrumentId: number;
  fromEpochId: EpochId;
  /** Null is a seal to nobody, which closes the epoch dormant. This is legal. */
  toOrgId: OrgId | null;
  brokerOrgId: OrgId | null;
  status: TransferStatus;
  withheldEventIds: EventId[];
  bundleRecordId: number | null;
  sealHash: string | null;
  initiatedBy: OrgId;
  sealedAt: Date | null;
  acceptedAt: Date | null;
};

/** Everything view.ts needs about one machine. Assembled by Phase 3's loader. */
export type SystemChain = {
  instrumentId: number;
  epochs: Epoch[];
  events: SystemEvent[];
  grants: Grant[];
};
