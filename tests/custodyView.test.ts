import { describe, expect, it } from "vitest";
import {
  WITHHELD_MARKER, anchor, authorLabel, custodianLabel, epochParties, eventVisibility,
  levelOf, viewOf,
} from "@/lib/custody/view";
import {
  handoffGradeOf, type Epoch, type EpochLevel, type Grant, type OrgRef, type SystemChain,
  type SystemEvent,
} from "@/lib/custody/types";

/**
 * The truth table. Every rule in docs/adr/0001-custody-and-provenance.md is a row
 * here, checked from BOTH sides - the failure this file exists to prevent is a
 * machine's history leaking sideways to an org that merely touched it once, and
 * the mirror failure of a shop losing sight of work it did itself because a
 * grant was later revoked. Both are silent in production and neither is
 * recoverable, so they get asserted rather than reasoned about.
 */

const org = (id: number, name: string, kind: OrgRef["kind"], over: Partial<OrgRef> = {}): OrgRef => ({
  id, name, kind, showNameDownstream: false, verifiedAt: new Date("2026-01-01"), ...over,
});

const epoch = (over: Partial<Epoch> & Pick<Epoch, "id" | "n" | "custodianOrgId">): Epoch => ({
  instrumentId: 1, custodianName: "", openedByEventId: null, closedByEventId: null,
  closeKind: "open", sealedAt: null, sealHash: null, brokerOrgId: null, ...over,
});

const grant = (over: Partial<Grant> & Pick<Grant, "id" | "epochId" | "granteeOrgId">): Grant => ({
  instrumentId: 1, grantedByOrgId: 0, kind: "service", scope: {},
  startsAt: new Date("2026-01-01"), endsAt: null, endedAt: null, endedBy: null, endReason: null,
  ...over,
});

const event = (
  over: Partial<SystemEvent> & Pick<SystemEvent, "id" | "epochId" | "authorOrgId" | "custodianOrgId">,
): SystemEvent => ({
  instrumentId: 1, assetId: null, kind: "pm",
  occurredAt: new Date("2026-02-01"), recordedAt: new Date("2026-02-01"),
  commissionerOrgId: null, whoGrade: "self_reported", howGrade: "typed",
  procedureKeys: [], provenance: {}, private: {}, withheld: false,
  sourceKind: "manual", sourceId: null, prevHash: null, hash: null,
  ...over,
});

/** The level a viewer gets for each epoch, keyed by epoch number, for matrix asserts. */
const matrix = (viewerOrgId: number | null, chain: SystemChain): Record<number, EpochLevel> =>
  Object.fromEntries(chain.epochs.map((e) => [e.n, levelOf(viewerOrgId, e, chain)]));

// ---------------------------------------------------------------------------
// Scenario 1 - five parties, one handoff
//
// Foothill (a reseller) held the machine, brought Sierra Spectra in to service
// it, sold it through Basin, and Delta (a lab) holds it now with Cascade
// servicing. Every party is real, none of them should see all of it.
// ---------------------------------------------------------------------------

const FOOTHILL = 10, BASIN = 11, SIERRA = 12, DELTA = 13, CASCADE = 14, STRANGER = 99;

const ORGS: Record<number, OrgRef> = {
  [FOOTHILL]: org(FOOTHILL, "Foothill Instruments", "reseller"),
  [BASIN]: org(BASIN, "Basin Analytical", "broker"),
  [SIERRA]: org(SIERRA, "Sierra Spectra", "provider", { showNameDownstream: true }),
  [DELTA]: org(DELTA, "Delta Diagnostics", "lab"),
  [CASCADE]: org(CASCADE, "Cascade Service Co", "provider", { showNameDownstream: false }),
};

const E1 = 1, E2 = 2;

const scenario1 = (): SystemChain => ({
  instrumentId: 1,
  epochs: [
    epoch({ id: E1, n: 1, custodianOrgId: FOOTHILL, closeKind: "sealed", brokerOrgId: BASIN,
      sealedAt: new Date("2026-06-01") }),
    epoch({ id: E2, n: 2, custodianOrgId: DELTA, closeKind: "open" }),
  ],
  grants: [
    // Ended when the epoch sealed - and Sierra Spectra still sees epoch 1.
    grant({ id: 1, epochId: E1, granteeOrgId: SIERRA, grantedByOrgId: FOOTHILL,
      endedAt: new Date("2026-06-01"), endReason: "epoch_closed" }),
    grant({ id: 2, epochId: E2, granteeOrgId: CASCADE, grantedByOrgId: DELTA }),
  ],
  events: [
    event({ id: 1, epochId: E1, authorOrgId: FOOTHILL, custodianOrgId: FOOTHILL, kind: "intake",
      whoGrade: "attested", howGrade: "document_only" }),
    // The PM: Sierra's work, commissioned by the custodian. Basin was not in the room.
    event({ id: 2, epochId: E1, authorOrgId: SIERRA, custodianOrgId: FOOTHILL,
      commissionerOrgId: FOOTHILL, kind: "pm", whoGrade: "third_party", howGrade: "procedure_run",
      provenance: { findings: "Lamp replaced; baseline within spec." },
      private: { price: "480.00", contact: "Ray" } }),
    // The pre-sale exam: Basin paid for it, so Basin sees what it bought.
    event({ id: 3, epochId: E1, authorOrgId: SIERRA, custodianOrgId: FOOTHILL,
      commissionerOrgId: BASIN, kind: "inspection", whoGrade: "third_party",
      howGrade: "procedure_run",
      provenance: { findings: "Detector at 82% of nominal." },
      private: { price: "310.00", site: "Foothill floor 2" } }),
    event({ id: 4, epochId: E1, authorOrgId: FOOTHILL, custodianOrgId: FOOTHILL, kind: "transfer" }),
    event({ id: 5, epochId: E2, authorOrgId: CASCADE, custodianOrgId: DELTA,
      commissionerOrgId: DELTA, kind: "pm", provenance: { findings: "Quarterly PM complete." },
      private: { price: "520.00" } }),
  ],
});

describe("scenario 1: the level matrix", () => {
  const chain = scenario1();

  it("gives the outgoing custodian its own epoch and nothing after it", () => {
    expect(matrix(FOOTHILL, chain)).toEqual({ 1: "full", 2: "none" });
  });

  it("gives the broker the epoch it closed, and no window into the next one", () => {
    expect(matrix(BASIN, chain)).toEqual({ 1: "full", 2: "none" });
  });

  it("keeps a provider's view of its own epoch after the grant ended", () => {
    expect(matrix(SIERRA, chain)).toEqual({ 1: "full", 2: "none" });
  });

  it("gives the new custodian provenance of everything before it", () => {
    expect(matrix(DELTA, chain)).toEqual({ 1: "prov", 2: "full" });
  });

  it("reaches a later grantee backwards, never forwards", () => {
    expect(matrix(CASCADE, chain)).toEqual({ 1: "prov", 2: "full" });
  });

  it("anchors each viewer at its highest involvement", () => {
    expect(anchor(FOOTHILL, chain)).toBe(1);
    expect(anchor(DELTA, chain)).toBe(2);
    expect(anchor(STRANGER, chain)).toBe(0);
  });

  it("names the reason, so a surface can say why without re-deriving it", () => {
    const seen = Object.fromEntries(viewOf(BASIN, chain).epochs.map((e) => [e.epoch.n, e.reason]));
    expect(seen).toEqual({ 1: "broker", 2: "after_last_involvement" });
    const delta = Object.fromEntries(viewOf(DELTA, chain).epochs.map((e) => [e.epoch.n, e.reason]));
    expect(delta).toEqual({ 1: "below_anchor", 2: "custodian" });
  });

  it("counts every role as standing in the epoch", () => {
    const parties = epochParties(chain.epochs[0], chain.events, chain.grants);
    expect([...parties].sort((a, b) => a - b)).toEqual([FOOTHILL, BASIN, SIERRA].sort((a, b) => a - b));
  });
});

describe("scenario 1: the private payload is narrower than the epoch", () => {
  const chain = scenario1();
  const e1 = chain.epochs[0];
  const pm = chain.events[1];
  const exam = chain.events[2];

  it("shows the broker the exam it commissioned, in full", () => {
    const v = eventVisibility(BASIN, exam, e1, chain);
    expect(v.level).toBe("full");
    expect(v.private).toEqual({ price: "310.00", site: "Foothill floor 2" });
  });

  it("does not show the broker the PM it had nothing to do with", () => {
    const v = eventVisibility(BASIN, pm, e1, chain);
    expect(v.level).toBe("full");
    expect(v.private).toBeNull();
    expect(v.provenance).toEqual({ findings: "Lamp replaced; baseline within spec." });
  });

  it("shows the custodian of the span both payloads of work done in it", () => {
    expect(eventVisibility(FOOTHILL, pm, e1, chain).private).toEqual({ price: "480.00", contact: "Ray" });
  });

  it("shows the author its own private notes", () => {
    expect(eventVisibility(SIERRA, pm, e1, chain).private).toEqual({ price: "480.00", contact: "Ray" });
  });

  it("gives the next custodian provenance and no prices", () => {
    const v = eventVisibility(DELTA, pm, e1, chain);
    expect(v.level).toBe("prov");
    expect(v.provenance).toEqual({ findings: "Lamp replaced; baseline within spec." });
    expect(v.private).toBeNull();
    expect(v.procedureKeys).toEqual([]);
  });

  it("tells the previous custodian nothing at all about the epoch after its own", () => {
    const v = eventVisibility(FOOTHILL, chain.events[4], chain.epochs[1], chain);
    expect(v).toEqual({
      eventId: 5, level: "none", procedureKeys: null, provenance: null, private: null,
      withheldDownstream: false,
    });
  });
});

describe("scenario 1: names", () => {
  const chain = scenario1();
  const e1 = chain.epochs[0];

  it("names the custodian to a party and anonymizes it to a buyer", () => {
    expect(custodianLabel(FOOTHILL, e1, ORGS[FOOTHILL], chain)).toBe("Foothill Instruments");
    expect(custodianLabel(DELTA, e1, ORGS[FOOTHILL], chain)).toBe("Reseller, anonymized");
  });

  it("withholds a provider's name downstream when the provider has not opted in", () => {
    const pmInE2 = chain.events[4];
    expect(authorLabel(DELTA, pmInE2, ORGS[CASCADE], "full")).toBe("Cascade Service Co");
    // What a future custodian reads once epoch 2 is below their anchor.
    expect(authorLabel(STRANGER, pmInE2, ORGS[CASCADE], "prov"))
      .toBe("Service provider (name withheld by provider)");
  });

  it("carries a provider's name downstream when the provider opted in", () => {
    expect(authorLabel(DELTA, chain.events[1], ORGS[SIERRA], "prov")).toBe("Sierra Spectra");
  });

  it("does not undo the custodian anonymization through the byline", () => {
    // Foothill authored its own intake; naming the author would name the custodian.
    expect(authorLabel(DELTA, chain.events[0], ORGS[FOOTHILL], "prov")).toBe("custodian at the time");
    expect(authorLabel(FOOTHILL, chain.events[0], ORGS[FOOTHILL], "full")).toBe("Foothill Instruments");
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 - the auction chain
//
// LabZen sold at auction to GMI, who did nothing to it and flipped it to
// Northbay. Sierra Spectra serviced it under LabZen and is brought back by
// Northbay years later - the case the anchor rule exists for.
// ---------------------------------------------------------------------------

const LABZEN = 20, SS = 21, GMI = 22, NORTHBAY = 23;
const A1 = 1, A2 = 2, A3 = 3;

const scenario2 = (): SystemChain => ({
  instrumentId: 2,
  epochs: [
    epoch({ id: A1, n: 1, custodianOrgId: LABZEN, closeKind: "sealed", instrumentId: 2 }),
    epoch({ id: A2, n: 2, custodianOrgId: GMI, closeKind: "sealed", instrumentId: 2 }),
    epoch({ id: A3, n: 3, custodianOrgId: NORTHBAY, closeKind: "open", instrumentId: 2 }),
  ],
  grants: [
    grant({ id: 1, epochId: A1, granteeOrgId: SS, grantedByOrgId: LABZEN, instrumentId: 2,
      endedAt: new Date("2026-03-01"), endReason: "epoch_closed" }),
    grant({ id: 2, epochId: A3, granteeOrgId: SS, grantedByOrgId: NORTHBAY, instrumentId: 2 }),
  ],
  events: [
    event({ id: 1, epochId: A1, authorOrgId: LABZEN, custodianOrgId: LABZEN, instrumentId: 2,
      kind: "intake", whoGrade: "attested", howGrade: "document_only" }),
    event({ id: 2, epochId: A1, authorOrgId: LABZEN, custodianOrgId: LABZEN, instrumentId: 2,
      kind: "qualification", whoGrade: "self_reported", howGrade: "typed",
      provenance: { findings: "Checkout passed on our own bench." } }),
    event({ id: 3, epochId: A3, authorOrgId: SS, custodianOrgId: NORTHBAY, instrumentId: 2,
      commissionerOrgId: NORTHBAY, kind: "pm", whoGrade: "third_party", howGrade: "procedure_run" }),
  ],
});

describe("scenario 2: a later grant reaches backwards", () => {
  const chain = scenario2();

  it("gives the returning provider full on both its own epochs and provenance between", () => {
    expect(matrix(SS, chain)).toEqual({ 1: "full", 2: "prov", 3: "full" });
  });

  it("closes the flipper out of the epoch after its own", () => {
    expect(matrix(GMI, chain)).toEqual({ 1: "prov", 2: "full", 3: "none" });
  });

  it("gives the current holder provenance of everything before it", () => {
    expect(matrix(NORTHBAY, chain)).toEqual({ 1: "prov", 2: "prov", 3: "full" });
  });

  it("anonymizes both previous custodians to the current holder", () => {
    expect(custodianLabel(NORTHBAY, chain.epochs[0], org(LABZEN, "LabZen", "reseller"), chain))
      .toBe("Reseller, anonymized");
    expect(custodianLabel(NORTHBAY, chain.epochs[1], org(GMI, "GMI Surplus", "reseller"), chain))
      .toBe("Reseller, anonymized");
  });

  it("carries an empty epoch as an empty epoch, not as an absent one", () => {
    // GMI wrote nothing. The gap is the point: two years and no maintenance is a
    // fact about the machine, and a chain that omits the span hides it.
    const seen = viewOf(NORTHBAY, chain).epochs.map((e) => e.epoch.n);
    expect(seen).toEqual([1, 2, 3]);
    expect(chain.events.filter((e) => e.epochId === A2)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Withholding, strangers, and the close kinds
// ---------------------------------------------------------------------------

describe("withheld free text", () => {
  const chain = scenario2();
  const withheld = { ...chain.events[1], withheld: true };
  const e1 = chain.epochs[0];

  it("leaves the original with the parties, and says it was held back", () => {
    const v = eventVisibility(LABZEN, withheld, e1, chain);
    expect(v.provenance).toEqual({ findings: "Checkout passed on our own bench." });
    expect(v.withheldDownstream).toBe(true);
  });

  it("gives everyone else the marker and the fact that there was something", () => {
    const v = eventVisibility(NORTHBAY, withheld, e1, chain);
    expect(v.level).toBe("prov");
    expect(v.provenance).toEqual({ findings: WITHHELD_MARKER });
    expect(v.withheldDownstream).toBe(true);
  });

  it("never withholds the structured half", () => {
    const keys = [{ key: "hplc/replace-lamp", state: "done" as const }];
    const v = eventVisibility(NORTHBAY, { ...withheld, procedureKeys: keys }, e1, chain);
    expect(v.procedureKeys).toEqual(keys);
  });
});

describe("a machine nobody on the platform holds", () => {
  // instruments.owner_org_id has always been nullable and has always meant
  // house stewardship - the operator's own bench, or a system logged before its
  // owner joined. The rule that matters is that the hole is not a party: an org
  // with no id must never match an epoch with no custodian.
  const chain = (): SystemChain => ({
    instrumentId: 3,
    epochs: [epoch({ id: 1, n: 1, custodianOrgId: null, custodianName: "house stewardship",
      closeKind: "sealed", instrumentId: 3 })],
    grants: [grant({ id: 1, epochId: 1, granteeOrgId: SIERRA, instrumentId: 3 })],
    events: [event({ id: 1, epochId: 1, authorOrgId: null, custodianOrgId: null, instrumentId: 3,
      kind: "intake", provenance: { findings: "Arrived on the bench." } })],
  });

  it("makes nobody a party to it", () => {
    expect(epochParties(chain().epochs[0], chain().events, chain().grants)).toEqual(new Set([SIERRA]));
  });

  it("still gives the org that worked on it its full view", () => {
    expect(matrix(SIERRA, chain())).toEqual({ 1: "full" });
  });

  it("tells a stranger nothing, rather than matching null to null", () => {
    expect(viewOf(STRANGER, chain())).toEqual({ epochs: [] });
    expect(viewOf(null, chain())).toEqual({ epochs: [] });
  });
});

describe("a viewer with no relationship", () => {
  it("is told nothing, not even how many times it changed hands", () => {
    expect(viewOf(STRANGER, scenario1())).toEqual({ epochs: [] });
    expect(viewOf(null, scenario2())).toEqual({ epochs: [] });
  });
});

describe("how an epoch ended", () => {
  it("maps every close kind, and calls an unsealed gap a gap", () => {
    expect(handoffGradeOf("open")).toBeNull();
    expect(handoffGradeOf("sealed")).toBe("sealed");
    expect(handoffGradeOf("steward_sealed")).toBe("steward_sealed");
    expect(handoffGradeOf("dormant")).toBe("dormant_gap");
    expect(handoffGradeOf("claimed")).toBe("closed_by_claim");
  });
});
