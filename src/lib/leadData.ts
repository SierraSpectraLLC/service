// The reads behind leads. The rules are lib/lead and stay pure.

import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { leadOffers, leads, orgs } from "@/db/schema";
import { parseSystems, publicOnly, type LeadPrivate, type LeadPublic } from "@/lib/lead";
import type { FeeTerms } from "@/lib/referral";

export type LeadRow = LeadPublic & Partial<LeadPrivate> & {
  id: number;
  status: string;
  createdOn: string;
  createdBy: string;
  /** The finder's workspace. */
  fromOrgId: number | null;
  fromName: string;
  claimedByOrgId: number | null;
  claimedByName: string;
  /** How many shops it went to. Only the finder is told this. */
  offeredTo: number;
  /** True when this reader is allowed the contact details. */
  open: boolean;
};

const termsOf = (r: typeof leads.$inferSelect): FeeTerms => ({
  kind: r.feeKind, feeCents: r.feeCents, feeBps: r.feeBps,
  windowMonths: r.feeWindowMonths, minCents: r.feeMinCents, maxCents: r.feeMaxCents,
  note: r.feeNote,
});

/**
 * Leads this workspace posted, and leads it was offered.
 *
 * THE REDACTION HAPPENS HERE, at the edge, and by construction: a reader who
 * may not have the contact details is handed an object that does not contain
 * them. Filtering in a component would leave the fields one careless render
 * away from a screen, and this is the half somebody has paid not to have.
 */
export async function leadsFor(tenantOrgId: number | null): Promise<{
  mine: LeadRow[]; offered: LeadRow[];
}> {
  if (tenantOrgId === null) return { mine: [], offered: [] };
  const [mine, offers] = await Promise.all([
    db.select().from(leads).where(eq(leads.tenantOrgId, tenantOrgId))
      .orderBy(desc(leads.id)),
    db.select({ leadId: leadOffers.leadId }).from(leadOffers)
      .where(eq(leadOffers.toOrgId, tenantOrgId)),
  ]);
  const offeredIds = offers.map((o) => o.leadId);
  const offeredRows = offeredIds.length
    ? await db.select().from(leads).where(inArray(leads.id, offeredIds)).orderBy(desc(leads.id))
    : [];

  const all = [...mine, ...offeredRows];
  const orgIds = [...new Set(all.flatMap((r) =>
    [r.tenantOrgId, r.claimedByOrgId].filter((x): x is number => x !== null)))];
  const names = new Map(orgIds.length
    ? (await db.select({ id: orgs.id, name: orgs.name }).from(orgs).where(inArray(orgs.id, orgIds)))
      .map((o) => [o.id, o.name])
    : []);
  const counts = new Map<number, number>();
  if (mine.length) {
    for (const o of await db.select({ leadId: leadOffers.leadId }).from(leadOffers)
      .where(inArray(leadOffers.leadId, mine.map((r) => r.id)))) {
      counts.set(o.leadId, (counts.get(o.leadId) ?? 0) + 1);
    }
  }

  const shape = (r: typeof leads.$inferSelect, maySeeContact: boolean): LeadRow => {
    const pub: LeadPublic = {
      region: r.region, blurb: r.blurb, systems: parseSystems(r.systems), terms: termsOf(r),
    };
    const base = {
      ...publicOnly(pub),
      id: r.id, status: r.status,
      createdOn: r.createdAt.toISOString().slice(0, 10),
      createdBy: r.createdBy,
      fromOrgId: r.tenantOrgId,
      fromName: (r.tenantOrgId !== null ? names.get(r.tenantOrgId) : "") ?? "another service company",
      claimedByOrgId: r.claimedByOrgId,
      claimedByName: (r.claimedByOrgId !== null ? names.get(r.claimedByOrgId) : "") ?? "",
      offeredTo: counts.get(r.id) ?? 0,
      open: maySeeContact,
    };
    // The private half is ATTACHED, not merely unhidden - a reader without it
    // receives an object that has never held it.
    return maySeeContact
      ? {
        ...base,
        contactName: r.contactName, contactEmail: r.contactEmail,
        contactPhone: r.contactPhone, orgName: r.orgName, address: r.address,
      }
      : base;
  };

  return {
    // The finder always sees their own in full.
    mine: mine.map((r) => shape(r, true)),
    // A shop it was offered to sees the contact only once they have claimed it.
    offered: offeredRows.map((r) => shape(r, r.claimedByOrgId === tenantOrgId)),
  };
}

/** One lead with the shops it went to, for the actions that decide about it. */
export async function leadWithOffers(id: number): Promise<
  { lead: typeof leads.$inferSelect; toOrgIds: number[] } | null
> {
  const [lead] = await db.select().from(leads).where(eq(leads.id, id));
  if (!lead) return null;
  const rows = await db.select({ toOrgId: leadOffers.toOrgId }).from(leadOffers)
    .where(eq(leadOffers.leadId, id)).orderBy(asc(leadOffers.id));
  return { lead, toOrgIds: rows.map((r) => r.toOrgId) };
}

/** Was this workspace offered this lead at all? */
export async function wasOffered(leadId: number, orgId: number): Promise<boolean> {
  const rows = await db.select({ id: leadOffers.id }).from(leadOffers)
    .where(and(eq(leadOffers.leadId, leadId), eq(leadOffers.toOrgId, orgId)));
  return rows.length > 0;
}
