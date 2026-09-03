// Countersign: an outside shop confirming that work attributed to it happened.
//
// A backfilled or scanned line says "Sierra Spectra changed the lamp". That is
// the custodian's word about somebody else's work, graded `attested`, and it is
// worth exactly that. If Sierra is on the platform, Sierra can say so too - and
// the line becomes `third_party`, which is the only way a machine's history
// from before this platform can ever be worth more than its holder's say-so.
//
// The grade is the one column the append-only trigger lets a confirmation
// change. It is not hashed (see hash.ts for why), so the chain does not move:
// a test asserts the hash before and after are the same bytes.

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { eventConfirmations, orgs, systemEvents } from "@/db/schema";
import type { Actor } from "@/lib/custody/transfer";

export type CountersignOutcome =
  | { status: "pending"; id: number; orgId: number }
  | { status: "invited"; id: number; namedProvider: string }
  | { status: "already"; id: number };

/**
 * Ask the named provider to confirm one line. If they are on the platform the
 * row waits for them; if not, it waits as `invited` for the day they join,
 * and the caller turns the name into an invitation through the existing
 * client-share path (that is app/actions' job - it needs a session).
 */
export async function requestCountersign(eventId: number, namedProvider: string, requestedBy: string): Promise<CountersignOutcome> {
  const name = namedProvider.trim();
  const [existing] = await db.select().from(eventConfirmations)
    .where(and(eq(eventConfirmations.eventId, eventId), sql`${eventConfirmations.status} in ('pending','confirmed','invited')`)).limit(1);
  if (existing) return { status: "already", id: existing.id };

  const [org] = name ? await db.select({ id: orgs.id }).from(orgs)
    .where(sql`lower(${orgs.name}) = ${name.toLowerCase()}`).limit(1) : [];
  if (org) {
    const [row] = await db.insert(eventConfirmations).values({
      eventId, orgId: org.id, namedProvider: name, status: "pending", requestedBy,
    }).returning({ id: eventConfirmations.id });
    return { status: "pending", id: row.id, orgId: org.id };
  }
  const [row] = await db.insert(eventConfirmations).values({
    eventId, orgId: null, namedProvider: name, status: "invited", requestedBy,
  }).returning({ id: eventConfirmations.id });
  return { status: "invited", id: row.id, namedProvider: name };
}

/** May this actor answer for the org that was asked? */
function speaksFor(actor: Actor, orgId: number): boolean {
  return actor.orgId === orgId || actor.operatorOrgId === orgId;
}

/**
 * The named provider says yes. The GRADE moves to third_party; the AUTHOR does
 * not move. The plan had the author change too, but author_org_id is inside the
 * hash (lib/custody/hash, Phase 2) and a chain that has to be re-linked to
 * record a confirmation is a chain nobody can trust to record one. The honest
 * shape is also the true one: the holder wrote the line, and this row is the
 * provider saying it happened. Readers wanting the confirming org's name read
 * event_confirmations, and orgs.show_name_downstream still governs it.
 */
export async function confirmCountersign(actor: Actor, confirmationId: number): Promise<{ error?: string }> {
  const [c] = await db.select().from(eventConfirmations).where(eq(eventConfirmations.id, confirmationId)).limit(1);
  if (!c || c.orgId === null) return { error: "Not found" };
  if (c.status !== "pending") return { error: `This request is ${c.status}.` };
  if (!speaksFor(actor, c.orgId)) return { error: "Only the provider that was named can confirm it." };
  const now = new Date();
  await db.update(systemEvents).set({ whoGrade: "third_party" }).where(eq(systemEvents.id, c.eventId));
  await db.update(eventConfirmations).set({ status: "confirmed", decidedAt: now, decidedBy: actor.email })
    .where(eq(eventConfirmations.id, c.id));
  return {};
}

/** The named provider says no. The line stays exactly as the holder wrote it. */
export async function declineCountersign(actor: Actor, confirmationId: number, note = ""): Promise<{ error?: string }> {
  const [c] = await db.select().from(eventConfirmations).where(eq(eventConfirmations.id, confirmationId)).limit(1);
  if (!c || c.orgId === null) return { error: "Not found" };
  if (c.status !== "pending") return { error: `This request is ${c.status}.` };
  if (!speaksFor(actor, c.orgId)) return { error: "Only the provider that was named can decline it." };
  await db.update(eventConfirmations).set({ status: "declined", decidedAt: new Date(), decidedBy: actor.email, note: note.trim().slice(0, 500) })
    .where(eq(eventConfirmations.id, c.id));
  return {};
}

/**
 * A provider joined. Every `invited` row naming them becomes `pending`, so the
 * requests that were waiting for them are waiting ON them.
 */
export async function adoptInvitations(orgId: number, orgName: string): Promise<number> {
  const rows = await db.update(eventConfirmations)
    .set({ orgId, status: "pending" })
    .where(and(eq(eventConfirmations.status, "invited"), sql`lower(${eventConfirmations.namedProvider}) = ${orgName.trim().toLowerCase()}`))
    .returning({ id: eventConfirmations.id });
  return rows.length;
}

/** What is waiting on one org, for its inbox. */
export const pendingFor = (orgId: number) =>
  db.select().from(eventConfirmations)
    .where(and(eq(eventConfirmations.orgId, orgId), eq(eventConfirmations.status, "pending")));
