// Claims: history entering a new custody when the holder cannot or will not
// seal.
//
// approveClaim moved owner_org_id on a platform admin's say-so and left the
// previous owner's access "in place". A serial number is not proof of
// purchase, and the previous holder was never asked. A claim here is a NOTICE:
// evidence goes on file, the open tenure's holder (or its steward) and every
// author in it are told, and a window runs (CLAIM_NOTICE_DAYS). Silence
// resolves it - the tenure closes as `claimed`, the holder keeps a frozen
// bundle exactly as a seal would give them, and the claimant's tenure opens.
// An objection parks it for a person. The holder can also simply seal to the
// claimant, which is the same outcome with a better grade on it.
//
// FREE TEXT WAITS. Structured provenance crosses to the claimant at once - it
// is readings, parts and dates, and it names nobody. The free text of the
// claimed tenure crosses when the window ends, unless its AUTHOR withheld it
// during the window (the same `withheld` flag a seal uses). Authors are told
// for exactly that reason.

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  accessRequests, custodyEpochs, custodyEvents, houseMembers, instruments, orgs, systemEvents, systemShares,
} from "@/db/schema";
import { appendEvent } from "@/lib/custody/append";
import { CLAIM_NOTICE_DAYS } from "@/lib/custody/policy";
import { freezeAndClose, openNextEpoch, custodianStanding, type Actor } from "@/lib/custody/transfer";

export type Resolution = "sealed_by_holder" | "disputed" | "resolved_silent" | "denied";

export type ClaimRow = typeof accessRequests.$inferSelect;

const DAY = 24 * 3600 * 1000;

/**
 * A CLAIM'S AUTHORITY TO MOVE A MACHINE IS THAT ITS WINDOW HAS RUN. Not a role,
 * not a session - the notice was served and nobody objected, or the platform
 * decided (which sets the window to now). Every write that moves custody on a
 * claim goes through this, and tests/tenantWriteScoping names it as the guard
 * because it is one: a claim whose clock has not run cannot move anything, and
 * neither can a row somebody forged without a notice.
 */
export function claimIsDue(c: Pick<ClaimRow, "kind" | "status" | "resolution" | "noticeEndsAt">, now: Date): boolean {
  return c.kind === "claim" && c.status === "pending" && c.resolution === ""
    && c.noticeEndsAt !== null && c.noticeEndsAt.getTime() <= now.getTime();
}

/** Where a claim stands, for the panels. */
export function claimState(c: ClaimRow, now: Date): "window" | "due" | "disputed" | "resolved" {
  if (c.resolution) return c.resolution === "disputed" ? "disputed" : "resolved";
  if (c.noticeEndsAt && now >= c.noticeEndsAt) return "due";
  return "window";
}

/**
 * Who has to be told: the open tenure's holder - or its steward when the org
 * has nobody who can read - and every org that authored a line in it, because
 * their free text is what the window is about.
 */
export async function noticeAudience(instrumentId: number): Promise<{ custodianOrgId: number | null; stewardOrgId: number | null; authorOrgIds: number[] }> {
  const [open] = await db.select().from(custodyEpochs)
    .where(and(eq(custodyEpochs.instrumentId, instrumentId), eq(custodyEpochs.closeKind, "open"))).limit(1);
  if (!open) return { custodianOrgId: null, stewardOrgId: null, authorOrgIds: [] };
  let stewardOrgId: number | null = null;
  if (open.custodianOrgId !== null) {
    const [org] = await db.select({ parentOrgId: orgs.parentOrgId }).from(orgs).where(eq(orgs.id, open.custodianOrgId)).limit(1);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(houseMembers).where(eq(houseMembers.orgId, open.custodianOrgId));
    if (n === 0 && org?.parentOrgId != null) stewardOrgId = org.parentOrgId;
  }
  const authors = await db.selectDistinct({ authorOrgId: systemEvents.authorOrgId }).from(systemEvents)
    .where(eq(systemEvents.epochId, open.id));
  const authorOrgIds = authors.map((a) => a.authorOrgId).filter((x): x is number => x !== null && x !== open.custodianOrgId);
  return { custodianOrgId: open.custodianOrgId, stewardOrgId, authorOrgIds };
}

/**
 * Turn a pending claim row into a NOTICED one: evidence on file, window set.
 * Called right after requestAccess(kind='claim') wrote the row.
 *
 * A dormant machine resolves at once - nobody holds it and the gap is already
 * in the record - so the claimant's tenure opens today with no window and the
 * dormant epoch's closeKind untouched.
 */
export async function noticeClaim(claimId: number, evidenceAttachmentId: number | null, now = new Date()): Promise<{ error?: string; immediate?: boolean; noticeEndsAt?: Date }> {
  const [c] = await db.select().from(accessRequests).where(eq(accessRequests.id, claimId)).limit(1);
  if (!c || c.kind !== "claim" || c.status !== "pending") return { error: "Not found" };
  const [open] = await db.select().from(custodyEpochs)
    .where(and(eq(custodyEpochs.instrumentId, c.instrumentId), eq(custodyEpochs.closeKind, "open"))).limit(1);
  if (!open) {
    const [last] = await db.select().from(custodyEpochs).where(eq(custodyEpochs.instrumentId, c.instrumentId)).orderBy(desc(custodyEpochs.n)).limit(1);
    if (!last) return { error: "No custody is recorded for this machine yet - run the custody backfill first." };
    if (last.closeKind !== "dormant") return { error: "This machine is between holders; try again once its transfer settles." };
    await db.update(accessRequests).set({ evidenceAttachmentId, noticeEndsAt: now }).where(eq(accessRequests.id, c.id));
    await resolveSilently(c.id, now, "dormant");
    return { immediate: true, noticeEndsAt: now };
  }
  if (open.custodianOrgId === c.orgId) return { error: "You already hold this machine." };
  const noticeEndsAt = new Date(now.getTime() + CLAIM_NOTICE_DAYS * DAY);
  await db.update(accessRequests).set({ evidenceAttachmentId, noticeEndsAt }).where(eq(accessRequests.id, c.id));
  return { noticeEndsAt };
}

/** The holder, its steward, or an author objects. Parks it for a person. */
export async function dispute(actor: Actor, claimId: number, note: string): Promise<{ error?: string }> {
  const [c] = await db.select().from(accessRequests).where(eq(accessRequests.id, claimId)).limit(1);
  if (!c || c.kind !== "claim" || c.status !== "pending" || c.resolution) return { error: "Not found" };
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, c.instrumentId)).limit(1);
  const { custodianOrgId, stewardOrgId, authorOrgIds } = await noticeAudience(c.instrumentId);
  const [open] = await db.select().from(custodyEpochs)
    .where(and(eq(custodyEpochs.instrumentId, c.instrumentId), eq(custodyEpochs.closeKind, "open"))).limit(1);
  const holder = open && inst ? await custodianStanding(actor, open, inst.tenantOrgId) : null;
  const author = actor.orgId !== null && authorOrgIds.includes(actor.orgId)
    || actor.operatorOrgId !== null && authorOrgIds.includes(actor.operatorOrgId);
  const steward = stewardOrgId !== null && actor.operatorOrgId === stewardOrgId;
  if (!holder && !author && !steward) return { error: "Only the holder, its steward or an author of its record can object." };
  void custodianOrgId;
  await db.update(accessRequests).set({ resolution: "disputed", resolvedAt: new Date(), disputeNote: note.trim().slice(0, 2000) })
    .where(eq(accessRequests.id, c.id));
  return {};
}

/** The platform refuses it. Nothing moves. */
export async function deny(actor: Actor, claimId: number): Promise<{ error?: string }> {
  const [c] = await db.select().from(accessRequests).where(eq(accessRequests.id, claimId)).limit(1);
  if (!c || c.kind !== "claim" || c.status !== "pending") return { error: "Not found" };
  const now = new Date();
  await db.update(accessRequests).set({ status: "denied", resolution: "denied", resolvedAt: now, decidedBy: actor.email, decidedAt: now })
    .where(eq(accessRequests.id, c.id));
  return {};
}

/**
 * The holder sealed a transfer to the claimant while the window ran. Same
 * outcome, better grade: mark the claim so the cron leaves it alone.
 */
export async function markSealedByHolder(instrumentId: number, toOrgId: number, now = new Date()): Promise<void> {
  await db.update(accessRequests)
    .set({ status: "approved", resolution: "sealed_by_holder", resolvedAt: now })
    .where(and(eq(accessRequests.instrumentId, instrumentId), eq(accessRequests.orgId, toOrgId),
      eq(accessRequests.kind, "claim"), eq(accessRequests.status, "pending"), eq(accessRequests.resolution, "")));
}

/**
 * SILENT RESOLUTION. The window ran and nobody objected.
 *
 * Closes the open tenure as `claimed` with the holder's bundle frozen exactly
 * as a seal would - they never turned up, but their record is still theirs -
 * opens the claimant's tenure, appends the claim event, and puts the free
 * text of the claimed tenure under embargo until the window's end (which, for
 * a resolution the cron ran late, is already past).
 */
export async function resolveSilently(claimId: number, now = new Date(), why: "window" | "dormant" = "window"): Promise<{ error?: string; epochId?: number }> {
  const [c] = await db.select().from(accessRequests).where(eq(accessRequests.id, claimId)).limit(1);
  if (!c || !claimIsDue(c, now)) return { error: "Not found" };
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, c.instrumentId)).limit(1);
  const [claimant] = await db.select().from(orgs).where(eq(orgs.id, c.orgId)).limit(1);
  if (!inst || !claimant) return { error: "Not found" };
  const system: Actor = { email: "claims@ridgeline", name: "Claim resolution", role: "system", orgId: null, operatorOrgId: null };

  const [open] = await db.select().from(custodyEpochs)
    .where(and(eq(custodyEpochs.instrumentId, inst.id), eq(custodyEpochs.closeKind, "open"))).limit(1);
  let fromOrgId: number | null = null, fromName = "", closedByEventId: number | null = null;

  if (open) {
    fromOrgId = open.custodianOrgId; fromName = open.custodianName;
    const [moved] = await db.insert(custodyEvents).values({
      instrumentId: inst.id, kind: "claim", fromOrgId, toOrgId: c.orgId, fromName, toName: claimant.name,
      note: `claim ${c.id} resolved ${why === "dormant" ? "at once - the machine was dormant" : "after the notice window ran with no objection"}`,
      actor: c.requestedBy, at: now,
    }).returning({ id: custodyEvents.id });
    // Authored by nobody, on purpose: an author is a party to the tenure, and
    // the claimant must read the tenure they took as provenance - anonymized,
    // embargoed - not as a party who happened to be named on its last line.
    const appended = await appendEvent({
      instrumentId: inst.id, kind: "claim", occurredAt: now, authorOrgId: null, custodianOrgId: fromOrgId,
      whoGrade: "attested", howGrade: "document_only",
      provenance: { handoff: "claimed", fromName, toName: claimant.name, noticeDays: CLAIM_NOTICE_DAYS },
      private: { claimId: c.id, evidenceAttachmentId: c.evidenceAttachmentId, requestedBy: c.requestedBy, message: c.message },
      sourceKind: "custody_event", sourceId: String(moved.id), epochId: open.id,
    });
    closedByEventId = appended.id;
    const [last] = await db.select({ hash: systemEvents.hash }).from(systemEvents)
      .where(eq(systemEvents.instrumentId, inst.id)).orderBy(desc(systemEvents.id)).limit(1);
    await freezeAndClose({
      inst, epoch: open, actor: system, closeKind: "claimed", held: [], closedByEventId: appended.id,
      sealHash: last?.hash ?? "", now, brokerOrgId: null, toOrgId: c.orgId, toName: claimant.name,
      custodianName: fromName, reviewedAt: null,
      findingsEmbargoUntil: c.noticeEndsAt ?? now,
    });
  } else {
    // Dormant: the gap is already in the record; just the moment.
    const [moved] = await db.insert(custodyEvents).values({
      instrumentId: inst.id, kind: "claim", fromOrgId: null, toOrgId: c.orgId, fromName: "", toName: claimant.name,
      note: `claim ${c.id} on a dormant machine`, actor: c.requestedBy, at: now,
    }).returning({ id: custodyEvents.id });
    void moved;
  }

  const epochId = await openNextEpoch(inst.id, c.orgId, claimant.name, closedByEventId);
  await db.update(instruments).set({ ownerOrgId: c.orgId }).where(eq(instruments.id, inst.id));
  await db.insert(systemShares).values({ instrumentId: inst.id, orgId: c.orgId, access: "edit", addedBy: c.requestedBy })
    .onConflictDoUpdate({ target: [systemShares.instrumentId, systemShares.orgId], set: { access: "edit" } });
  if (fromOrgId !== null) {
    await db.delete(systemShares).where(and(eq(systemShares.instrumentId, inst.id), eq(systemShares.orgId, fromOrgId)));
  }
  await db.update(accessRequests)
    .set({ status: "approved", resolution: "resolved_silent", resolvedAt: now, decidedBy: system.email, decidedAt: now })
    .where(eq(accessRequests.id, c.id));
  return { epochId };
}

/** Everything whose window has run. The cron and the script both call this. */
export async function runClaimResolutions(now = new Date()): Promise<{ resolved: number[]; skipped: { id: number; why: string }[] }> {
  const due = await db.select().from(accessRequests).where(and(
    eq(accessRequests.kind, "claim"), eq(accessRequests.status, "pending"), eq(accessRequests.resolution, ""),
    sql`${accessRequests.noticeEndsAt} IS NOT NULL AND ${accessRequests.noticeEndsAt} <= ${now}`,
  ));
  const resolved: number[] = [], skipped: { id: number; why: string }[] = [];
  for (const c of due) {
    const res = await resolveSilently(c.id, now);
    if (res.error) skipped.push({ id: c.id, why: res.error }); else resolved.push(c.id);
  }
  return { resolved, skipped };
}

/** Disputed claims, for the admin screen. */
export const disputedClaims = () =>
  db.select().from(accessRequests).where(and(eq(accessRequests.kind, "claim"), eq(accessRequests.resolution, "disputed")));

/**
 * The admin decides a disputed claim: grant it (resolve as if silent) or deny.
 */
export async function decideDisputed(actor: Actor, claimId: number, grant: boolean): Promise<{ error?: string }> {
  const [c] = await db.select().from(accessRequests).where(eq(accessRequests.id, claimId)).limit(1);
  if (!c || c.kind !== "claim" || c.resolution !== "disputed") return { error: "Not found" };
  if (!grant) {
    await db.update(accessRequests).set({ status: "denied", resolution: "denied", resolvedAt: new Date(), decidedBy: actor.email, decidedAt: new Date() })
      .where(eq(accessRequests.id, c.id));
    return {};
  }
  // Un-park it and date the window to now - a platform decision IS the notice
  // having run - then resolve through the one path that knows how.
  const now = new Date();
  await db.update(accessRequests).set({ resolution: "", noticeEndsAt: now }).where(eq(accessRequests.id, c.id));
  const res = await resolveSilently(c.id, now);
  if (res.error) {
    await db.update(accessRequests).set({ resolution: "disputed" }).where(eq(accessRequests.id, c.id));
    return { error: res.error };
  }
  await db.update(accessRequests).set({ decidedBy: actor.email }).where(eq(accessRequests.id, c.id));
  return {};
}

/** Withhold an author's own line during a claim window. Reuses `withheld`. */
export async function withholdOwnLine(actor: Actor, eventId: number): Promise<{ error?: string }> {
  const [e] = await db.select().from(systemEvents).where(eq(systemEvents.id, eventId)).limit(1);
  if (!e) return { error: "Not found" };
  const mine = e.authorOrgId !== null && (e.authorOrgId === actor.orgId || e.authorOrgId === actor.operatorOrgId);
  if (!mine) return { error: "Only the author of a line can hold it back." };
  const live = await db.select({ id: accessRequests.id }).from(accessRequests).where(and(
    eq(accessRequests.instrumentId, e.instrumentId), eq(accessRequests.kind, "claim"),
    eq(accessRequests.status, "pending"), eq(accessRequests.resolution, ""), isNull(accessRequests.resolvedAt),
  )).limit(1);
  if (!live.length) return { error: "There is no claim window open on this machine." };
  await db.update(systemEvents).set({ withheld: true }).where(eq(systemEvents.id, e.id));
  return {};
}

export { inArray };
