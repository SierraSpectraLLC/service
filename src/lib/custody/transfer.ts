// Custody changing hands: initiate, review, seal, accept.
//
// handOffSystem moves owner_org_id in one call. Nothing is reviewed, nothing
// is hashed, and the recipient is handed a machine they never said yes to.
// This is the same act with a shape: the outgoing holder sees exactly what the
// record will say to a stranger, holds back the free text it must, and seals -
// which freezes a bundle over exactly those events and closes the epoch. The
// recipient then accepts, which opens theirs. Nothing between seal and accept
// can add to the record, from the app or from below it.
//
// NO TRANSACTIONS. The production driver is neon-http (see append.ts), so the
// seal is ordered so that every intermediate state is honest: withhold first
// (allowed on a live epoch, meaningless until sealed), append the transfer
// event (the last line of the closing record), freeze the bundle (so it
// contains that line), then close the epoch (which locks the bundle's
// contents), then end grants and file the transfer. A crash between steps
// leaves a resumable state, never a lie.

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "@/db";
import {
  custodyEpochs, custodyEvents, engagementRecords, grants, houseMembers, instruments,
  orgs, systemEvents, systemShares, transfers,
} from "@/db/schema";
import { appendEvent } from "@/lib/custody/append";
import { canonical } from "@/lib/custody/hash";
import { custodyContext } from "@/lib/custody/load";
import { WITHHELD_MARKER } from "@/lib/custody/view";
import type { Epoch, SystemEvent } from "@/lib/custody/types";
import { composeSystemDossier, type SystemDossier } from "@/lib/dossier";
import { clientAfterHandoff } from "@/lib/owner";

export type Actor = {
  email: string;
  name: string;
  role: string;
  orgId: number | null;
  operatorOrgId: number | null;
};

/** `error?: never` on the success side is what lets `if (res.error) return` narrow. */
export type Outcome<T = object> = { error: string } | ({ error?: never } & T);

/** Where one machine's custody stands, for the panel. */
export type PendingTransfer = {
  id: number; status: string; toOrgId: number | null; toName: string;
  brokerOrgId: number | null; withheldEventIds: number[]; sealedAt: Date | null;
};

const IN_FLIGHT = ["initiated", "reviewed", "sealed"];

// ── Who may act ─────────────────────────────────────────────────────────────

/**
 * The custodian's own people, or the operator STEWARDING a memberless org.
 *
 * The second case is the one that has to exist: a client org created by an
 * operator and never given a login cannot act, and the machines it holds
 * would be untransferable forever. Its operator seals on its behalf, marked as
 * such - see closeKind 'steward_sealed'.
 */
export async function custodianStanding(
  actor: Actor, epoch: { custodianOrgId: number | null }, instrumentTenantOrgId: number | null,
): Promise<"custodian" | "steward" | null> {
  if (epoch.custodianOrgId === null) {
    // House stewardship: the operator whose workspace the machine sits in.
    return actor.operatorOrgId !== null && actor.operatorOrgId === instrumentTenantOrgId ? "custodian" : null;
  }
  if (actor.orgId === epoch.custodianOrgId) return "custodian";
  const [org] = await db.select({ parentOrgId: orgs.parentOrgId, isOperator: orgs.isOperator })
    .from(orgs).where(eq(orgs.id, epoch.custodianOrgId)).limit(1);
  if (!org) return null;
  // An operator's own staff act for the operator itself.
  if (org.isOperator && actor.operatorOrgId === epoch.custodianOrgId) return "custodian";
  if (org.parentOrgId !== null && org.parentOrgId === actor.operatorOrgId) {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(houseMembers)
      .where(eq(houseMembers.orgId, epoch.custodianOrgId));
    return n === 0 ? "steward" : null;
  }
  return null;
}

/** May this actor accept on behalf of the recipient org? */
export async function recipientStanding(actor: Actor, toOrgId: number): Promise<boolean> {
  if (actor.orgId === toOrgId) return true;
  const [org] = await db.select({ parentOrgId: orgs.parentOrgId, isOperator: orgs.isOperator })
    .from(orgs).where(eq(orgs.id, toOrgId)).limit(1);
  if (!org) return false;
  if (org.isOperator && actor.operatorOrgId === toOrgId) return true;
  // A steward accepts for its memberless client too - it created the org and
  // it is the only party that can.
  return org.parentOrgId !== null && org.parentOrgId === actor.operatorOrgId;
}

// ── Reads ───────────────────────────────────────────────────────────────────

export async function openEpoch(instrumentId: number) {
  const [e] = await db.select().from(custodyEpochs)
    .where(and(eq(custodyEpochs.instrumentId, instrumentId), eq(custodyEpochs.closeKind, "open"))).limit(1);
  return e ?? null;
}

export async function pendingTransfer(instrumentId: number): Promise<PendingTransfer | null> {
  const [t] = await db.select().from(transfers)
    .where(and(eq(transfers.instrumentId, instrumentId), sql`${transfers.status} in ('initiated','reviewed','sealed')`))
    .orderBy(desc(transfers.id)).limit(1);
  return t ? {
    id: t.id, status: t.status, toOrgId: t.toOrgId, toName: t.toName, brokerOrgId: t.brokerOrgId,
    withheldEventIds: (t.withheldEventIds as number[]) ?? [], sealedAt: t.sealedAt,
  } : null;
}

// ── The projection the recipient will get ───────────────────────────────────

export type ReviewLine = {
  eventId: number;
  kind: string;
  occurredAt: Date;
  /** The structured half. Never withholdable. */
  procedureKeys: SystemEvent["procedureKeys"];
  /** The travelling payload as the recipient will read it, marker applied. */
  provenance: Record<string, unknown>;
  /** Whether this line has free text at all - the only thing a toggle can hold back. */
  hasFindings: boolean;
  withheld: boolean;
};

/**
 * The outgoing epoch exactly as the recipient will see it: provenance level,
 * with the toggled events' free text replaced by the marker. Pure, so the
 * review screen and the seal cannot disagree about what travelled.
 */
export function projectionOf(epoch: Epoch, events: SystemEvent[], withheldIds: number[]): ReviewLine[] {
  const held = new Set(withheldIds);
  return events
    .filter((e) => e.epochId === epoch.id)
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id - b.id)
    .map((e) => {
      const withheld = e.withheld || held.has(e.id);
      const hasFindings = typeof e.provenance.findings === "string" && e.provenance.findings.length > 0;
      const provenance = withheld && hasFindings ? { ...e.provenance, findings: WITHHELD_MARKER } : { ...e.provenance };
      return { eventId: e.id, kind: e.kind, occurredAt: e.occurredAt, procedureKeys: e.procedureKeys, provenance, hasFindings, withheld };
    });
}

/** What gets frozen. Versioned, canonical, hashed. */
export type SealedBundle = {
  version: 1;
  sealedAt: string;
  instrument: { id: number; externalId: string; label: string };
  epoch: { n: number; custodianOrgId: number | null; custodianName: string; closeKind: string; brokerOrgId: number | null };
  transfer: { toOrgId: number | null; toName: string };
  /** The chain of this epoch, provenance-side only, withholding applied. */
  chain: { eventId: number; kind: string; occurredAt: string; whoGrade: string; howGrade: string; procedureKeys: unknown; provenance: Record<string, unknown>; hash: string }[];
  /** The holder's own full dossier - theirs to keep, never the recipient's. */
  dossier: SystemDossier;
};

export const bundleHash = (bundle: SealedBundle): string =>
  createHash("sha256").update(canonical(bundle), "utf8").digest("hex");

async function supersede(instrumentId: number, orgId: number, kind: string) {
  await db.update(engagementRecords).set({ supersededAt: new Date() })
    .where(and(
      eq(engagementRecords.instrumentId, instrumentId), eq(engagementRecords.orgId, orgId),
      eq(engagementRecords.kind, kind), isNull(engagementRecords.supersededAt),
    ));
}

// ── The machine ─────────────────────────────────────────────────────────────

export async function initiate(actor: Actor, input: {
  instrumentId: number; toOrgId: number | null; brokerOrgId?: number | null; note?: string;
}): Promise<Outcome<{ id: number }>> {
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, input.instrumentId)).limit(1);
  if (!inst) return { error: "Not found" };
  const epoch = await openEpoch(inst.id);
  if (!epoch) return { error: "No custody is recorded for this machine yet - run the custody backfill first." };
  const standing = await custodianStanding(actor, epoch, inst.tenantOrgId);
  if (!standing) return { error: "Only the current holder can transfer custody." };
  if (await pendingTransfer(inst.id)) return { error: "A transfer is already under way for this machine." };

  let toName = "";
  if (input.toOrgId !== null) {
    const [to] = await db.select().from(orgs).where(eq(orgs.id, input.toOrgId)).limit(1);
    if (!to) return { error: "Unknown organization" };
    if (to.id === epoch.custodianOrgId) return { error: `${to.name} already holds this machine.` };
    if (!to.canCustody) return { error: `${to.name} cannot hold custody - a platform admin sets that capability.` };
    toName = to.name;
  }
  if (input.brokerOrgId) {
    const [broker] = await db.select().from(orgs).where(eq(orgs.id, input.brokerOrgId)).limit(1);
    if (!broker) return { error: "Unknown broker" };
    if (!broker.canBroker) return { error: `${broker.name} cannot broker a transfer - a platform admin sets that capability.` };
  }

  const [row] = await db.insert(transfers).values({
    instrumentId: inst.id, fromEpochId: epoch.id, toOrgId: input.toOrgId, toName,
    brokerOrgId: input.brokerOrgId ?? null, note: (input.note ?? "").trim().slice(0, 500),
    initiatedBy: actor.email, initiatedByOrgId: actor.orgId ?? actor.operatorOrgId,
  }).returning({ id: transfers.id });
  return { id: row.id };
}

/**
 * What the recipient will read, with the holder's withhold choices applied.
 * Storing the choices here rather than at seal is what lets the screen show
 * the consequence of a toggle before anything is irreversible.
 */
export async function review(actor: Actor, transferId: number, withheldEventIds: number[]): Promise<Outcome<{ lines: ReviewLine[] }>> {
  const [t] = await db.select().from(transfers).where(eq(transfers.id, transferId)).limit(1);
  if (!t) return { error: "Not found" };
  if (!IN_FLIGHT.slice(0, 2).includes(t.status)) return { error: `This transfer is ${t.status}; nothing left to review.` };
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, t.instrumentId)).limit(1);
  const [epoch] = await db.select().from(custodyEpochs).where(eq(custodyEpochs.id, t.fromEpochId)).limit(1);
  if (!inst || !epoch) return { error: "Not found" };
  if (!(await custodianStanding(actor, epoch, inst.tenantOrgId))) return { error: "Only the current holder reviews what travels." };

  const ctx = await custodyContext(epoch.custodianOrgId, inst.id);
  const mine = new Set(ctx.chain.events.filter((e) => e.epochId === epoch.id).map((e) => e.id));
  // Only this epoch's own events can be held back, and only ones with text.
  const held = withheldEventIds.filter((id) => mine.has(id));
  const epochShape = ctx.chain.epochs.find((e) => e.id === epoch.id)!;
  const lines = projectionOf(epochShape, ctx.chain.events, held);

  await db.update(transfers).set({ withheldEventIds: held, status: "reviewed", reviewedAt: new Date() })
    .where(eq(transfers.id, t.id));
  return { lines };
}

/**
 * THE IRREVERSIBLE STEP. See the file header for why the order matters.
 */
export async function seal(actor: Actor, transferId: number): Promise<Outcome<{ bundleRecordId: number; sealHash: string; bundleHash: string }>> {
  const [t] = await db.select().from(transfers).where(eq(transfers.id, transferId)).limit(1);
  if (!t) return { error: "Not found" };
  if (t.status !== "reviewed") return { error: t.status === "initiated" ? "Review what travels before sealing." : `This transfer is ${t.status}.` };
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, t.instrumentId)).limit(1);
  const [epoch] = await db.select().from(custodyEpochs).where(eq(custodyEpochs.id, t.fromEpochId)).limit(1);
  if (!inst || !epoch) return { error: "Not found" };
  if (epoch.closeKind !== "open") return { error: "That tenure is already closed." };
  const standing = await custodianStanding(actor, epoch, inst.tenantOrgId);
  if (!standing) return { error: "Only the current holder seals." };

  const now = new Date();
  const held = (t.withheldEventIds as number[]) ?? [];

  // 1. Withhold. One of two columns the append-only trigger allows.
  for (const id of held) {
    await db.update(systemEvents).set({ withheld: true })
      .where(and(eq(systemEvents.id, id), eq(systemEvents.epochId, epoch.id)));
  }

  // 2. The moment, as the rest of the app records it - written at seal, not
  //    accept, because the seal is when the outgoing holder lets go. The
  //    chain event below takes this row as its source so the backfill's
  //    emitter converges on it instead of writing a second one.
  const [fromOrg] = epoch.custodianOrgId === null ? [] : await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, epoch.custodianOrgId));
  const fromName = epoch.custodianName || fromOrg?.name || "";
  const [moved] = await db.insert(custodyEvents).values({
    instrumentId: inst.id, kind: t.toOrgId === null ? "release" : "transfer",
    fromOrgId: epoch.custodianOrgId, toOrgId: t.toOrgId, fromName, toName: t.toName,
    note: t.note, actor: actor.email, at: now,
  }).returning({ id: custodyEvents.id });

  // 3. The transfer event: the last line of the closing record.
  const closeKind = t.toOrgId === null ? "dormant" : standing === "steward" ? "steward_sealed" : "sealed";
  const appended = await appendEvent({
    instrumentId: inst.id, kind: t.toOrgId === null ? "release" : "transfer", occurredAt: now,
    authorOrgId: actor.orgId ?? actor.operatorOrgId, custodianOrgId: epoch.custodianOrgId,
    whoGrade: "attested", howGrade: "document_only",
    provenance: { handoff: closeKind, fromName, toName: t.toName, withheld: held.length },
    private: {
      note: t.note, actor: actor.email, fromOrgId: epoch.custodianOrgId, toOrgId: t.toOrgId,
      brokerOrgId: t.brokerOrgId,
      // A steward seal says who acted, because the custodian did not.
      ...(standing === "steward" ? { stewardedBy: actor.email, stewardOrgId: actor.operatorOrgId } : {}),
    },
    sourceKind: "custody_event", sourceId: String(moved.id), epochId: epoch.id,
  });
  const [last] = await db.select({ hash: systemEvents.hash }).from(systemEvents)
    .where(eq(systemEvents.instrumentId, inst.id)).orderBy(desc(systemEvents.id)).limit(1);
  const sealHash = last?.hash ?? "";

  // 4. Freeze the bundle over exactly these events.
  const ctx = await custodyContext(epoch.custodianOrgId, inst.id);
  const epochShape = ctx.chain.epochs.find((e) => e.id === epoch.id)!;
  const lines = projectionOf(epochShape, ctx.chain.events, held);
  const dossier = epoch.custodianOrgId === null ? null : await composeSystemDossier(inst.id, epoch.custodianOrgId);
  const bundle: SealedBundle = {
    version: 1, sealedAt: now.toISOString(),
    instrument: { id: inst.id, externalId: inst.externalId, label: dossier?.label ?? inst.model },
    epoch: { n: epoch.n, custodianOrgId: epoch.custodianOrgId, custodianName: fromName, closeKind, brokerOrgId: t.brokerOrgId },
    transfer: { toOrgId: t.toOrgId, toName: t.toName },
    chain: lines.map((l) => {
      const e = ctx.chain.events.find((x) => x.id === l.eventId)!;
      return { eventId: l.eventId, kind: l.kind, occurredAt: l.occurredAt.toISOString(), whoGrade: e.whoGrade, howGrade: e.howGrade, procedureKeys: l.procedureKeys, provenance: l.provenance, hash: e.hash ?? "" };
    }),
    dossier: dossier ?? emptyDossier(inst),
  };
  const digest = bundleHash(bundle);
  let bundleRecordId = 0;
  if (epoch.custodianOrgId !== null) {
    await supersede(inst.id, epoch.custodianOrgId, "sealed");
    const [rec] = await db.insert(engagementRecords).values({
      instrumentId: inst.id, orgId: epoch.custodianOrgId, kind: "sealed", externalId: inst.externalId,
      label: bundle.instrument.label, revokedBy: actor.email, revokedAt: now, data: bundle, bundleHash: digest,
    }).returning({ id: engagementRecords.id });
    bundleRecordId = rec.id;
  }

  // 5. Close. From here the trigger refuses every append into this epoch.
  await db.update(custodyEpochs).set({
    closeKind, sealedAt: now, sealHash, closedByEventId: appended.id, brokerOrgId: t.brokerOrgId,
    redactionReviewedAt: t.reviewedAt ?? now,
  }).where(eq(custodyEpochs.id, epoch.id));

  // 6. Every grant on the epoch ends, and each grantee keeps a frozen record -
  //    the existing 'revoked' behaviour, because to them that is what happened.
  const live = await db.select().from(grants).where(and(eq(grants.epochId, epoch.id), isNull(grants.endedAt)));
  for (const g of live) {
    await db.update(grants).set({ endedAt: now, endedBy: epoch.custodianOrgId, endReason: "epoch_closed" }).where(eq(grants.id, g.id));
    const theirs = await composeSystemDossier(inst.id, g.granteeOrgId);
    if (theirs) {
      await supersede(inst.id, g.granteeOrgId, "revoked");
      await db.insert(engagementRecords).values({
        instrumentId: inst.id, orgId: g.granteeOrgId, kind: "revoked", externalId: inst.externalId,
        label: theirs.label, revokedBy: actor.email, revokedAt: now, data: theirs,
      });
    }
  }

  // 7. Seal to nobody: nobody holds it, and the pointer says so too.
  if (t.toOrgId === null) {
    await db.update(instruments).set({ ownerOrgId: null }).where(eq(instruments.id, inst.id));
  }

  await db.update(transfers).set({
    status: "sealed", sealedAt: now, sealedBy: actor.email, sealHash,
    bundleRecordId: bundleRecordId || null, custodyEventId: moved.id,
  }).where(eq(transfers.id, t.id));
  return { bundleRecordId, sealHash, bundleHash: digest };
}

export async function accept(actor: Actor, transferId: number): Promise<Outcome<{ epochId: number }>> {
  const [t] = await db.select().from(transfers).where(eq(transfers.id, transferId)).limit(1);
  if (!t) return { error: "Not found" };
  if (t.status !== "sealed") return { error: t.status === "accepted" ? "Already accepted." : "Nothing sealed to accept yet." };
  if (t.toOrgId === null) return { error: "This was sealed to nobody - there is no recipient to accept it." };
  if (!(await recipientStanding(actor, t.toOrgId))) return { error: "Only the recipient accepts custody." };
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, t.instrumentId)).limit(1);
  const [from] = await db.select().from(custodyEpochs).where(eq(custodyEpochs.id, t.fromEpochId)).limit(1);
  if (!inst || !from) return { error: "Not found" };
  if (await openEpoch(inst.id)) return { error: "Somebody else holds this machine already." };

  const now = new Date();
  const [{ maxN }] = await db.select({ maxN: sql<number>`coalesce(max(${custodyEpochs.n}), 0)::int` })
    .from(custodyEpochs).where(eq(custodyEpochs.instrumentId, inst.id));
  const [next] = await db.insert(custodyEpochs).values({
    instrumentId: inst.id, n: maxN + 1, custodianOrgId: t.toOrgId, custodianName: t.toName,
    openedByEventId: from.closedByEventId, closeKind: "open",
  }).returning({ id: custodyEpochs.id });

  // Compatibility with every surface that still reads the pointer and the
  // share table: the new holder owns it and can see it. lib/owner decides
  // whether the client label follows.
  await db.update(instruments).set({
    ownerOrgId: t.toOrgId, client: clientAfterHandoff(inst.client, from.custodianName, t.toName),
  }).where(eq(instruments.id, inst.id));
  await db.insert(systemShares).values({ instrumentId: inst.id, orgId: t.toOrgId, access: "edit", addedBy: actor.email })
    .onConflictDoUpdate({ target: [systemShares.instrumentId, systemShares.orgId], set: { access: "edit" } });
  if (from.custodianOrgId !== null) {
    await db.delete(systemShares).where(and(eq(systemShares.instrumentId, inst.id), eq(systemShares.orgId, from.custodianOrgId)));
  }

  await db.update(transfers).set({ status: "accepted", acceptedAt: now, acceptedBy: actor.email }).where(eq(transfers.id, t.id));
  return { epochId: next.id };
}

/** The holder changes their mind before sealing. Nothing has moved. */
export async function cancel(actor: Actor, transferId: number): Promise<Outcome> {
  const [t] = await db.select().from(transfers).where(eq(transfers.id, transferId)).limit(1);
  if (!t) return { error: "Not found" };
  if (t.status !== "initiated" && t.status !== "reviewed") return { error: `A ${t.status} transfer cannot be cancelled.` };
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, t.instrumentId)).limit(1);
  const [epoch] = await db.select().from(custodyEpochs).where(eq(custodyEpochs.id, t.fromEpochId)).limit(1);
  if (!inst || !epoch || !(await custodianStanding(actor, epoch, inst.tenantOrgId))) return { error: "Not yours to cancel." };
  await db.update(transfers).set({ status: "cancelled" }).where(eq(transfers.id, t.id));
  return {};
}

/**
 * The recipient says no.
 *
 * Before the seal, nothing has happened. After it, the holder's record is
 * frozen and cannot be unfrozen (the trigger sees to that), so the machine
 * becomes DORMANT: nobody holds it, the sealed bundle stands as evidence, and
 * the previous holder resumes by opening a fresh tenure - see resume.
 */
export async function decline(actor: Actor, transferId: number): Promise<Outcome> {
  const [t] = await db.select().from(transfers).where(eq(transfers.id, transferId)).limit(1);
  if (!t) return { error: "Not found" };
  if (!IN_FLIGHT.includes(t.status)) return { error: `A ${t.status} transfer cannot be declined.` };
  if (t.toOrgId === null || !(await recipientStanding(actor, t.toOrgId))) return { error: "Only the recipient declines." };
  if (t.status === "sealed") {
    await db.update(custodyEpochs).set({ closeKind: "dormant" }).where(eq(custodyEpochs.id, t.fromEpochId));
    await db.update(instruments).set({ ownerOrgId: null }).where(eq(instruments.id, t.instrumentId));
  }
  await db.update(transfers).set({ status: "declined" }).where(eq(transfers.id, t.id));
  return {};
}

/**
 * Take a dormant machine back into a fresh tenure. Only the last holder, and
 * only while nobody else does: the sealed epoch stays sealed - history is not
 * reopened, it is continued.
 */
export async function resume(actor: Actor, instrumentId: number): Promise<Outcome<{ epochId: number }>> {
  if (await openEpoch(instrumentId)) return { error: "Somebody holds this machine." };
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, instrumentId)).limit(1);
  const [last] = await db.select().from(custodyEpochs).where(eq(custodyEpochs.instrumentId, instrumentId))
    .orderBy(desc(custodyEpochs.n)).limit(1);
  if (!inst || !last) return { error: "Not found" };
  if (last.closeKind !== "dormant") return { error: "That machine is not dormant." };
  if (!(await custodianStanding(actor, last, inst.tenantOrgId))) return { error: "Only the last holder resumes custody." };
  const [next] = await db.insert(custodyEpochs).values({
    instrumentId, n: last.n + 1, custodianOrgId: last.custodianOrgId, custodianName: last.custodianName, closeKind: "open",
  }).returning({ id: custodyEpochs.id });
  await db.update(instruments).set({ ownerOrgId: last.custodianOrgId }).where(eq(instruments.id, instrumentId));
  return { epochId: next.id };
}

function emptyDossier(inst: typeof instruments.$inferSelect): SystemDossier {
  return {
    version: 1,
    system: { externalId: inst.externalId, client: inst.client, category: inst.category, location: inst.location, lead: inst.lead, notes: inst.notes, stages: inst.stages },
    label: inst.model, assets: [], gases: [], tasks: [], parts: [], attachments: [], discussion: [], activity: [],
  };
}

/** Sealed records for one org, newest first - the shelf the dashboard reads. */
export const sealedRecordsFor = (orgId: number) =>
  db.select().from(engagementRecords)
    .where(and(eq(engagementRecords.orgId, orgId), eq(engagementRecords.kind, "sealed"), isNull(engagementRecords.supersededAt)))
    .orderBy(desc(engagementRecords.revokedAt));

/** Seals since a moment, for the operator board's tile. */
export async function sealsSince(since: Date, tenantOrgId: number | null): Promise<{ instrumentId: number; externalId: string; toName: string; sealedAt: Date }[]> {
  const rows = await db.select({
    instrumentId: transfers.instrumentId, externalId: instruments.externalId, toName: transfers.toName, sealedAt: transfers.sealedAt,
    tenantOrgId: instruments.tenantOrgId,
  }).from(transfers).innerJoin(instruments, eq(instruments.id, transfers.instrumentId))
    .where(and(sql`${transfers.sealedAt} >= ${since}`, sql`${transfers.status} in ('sealed','accepted')`))
    .orderBy(asc(transfers.sealedAt));
  return rows.filter((r) => tenantOrgId === null || r.tenantOrgId === tenantOrgId)
    .map((r) => ({ instrumentId: r.instrumentId, externalId: r.externalId, toName: r.toName, sealedAt: r.sealedAt! }));
}
