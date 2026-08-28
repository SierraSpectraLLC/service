// Composing a client handover, and materializing one that was accepted.
// The rules are lib/clientShare and stay pure; this is the fetching and the
// one write that crosses a workspace boundary in the whole application.

import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { assets, clientShares, instruments, orgSites, orgs, providerProfiles } from "@/db/schema";
import { forTenant } from "@/lib/tenancy";
import { siteLabel } from "@/lib/sites";
import {
  freeTag, parsePayload, provenanceLine, SHARE_VERSION,
  type SharePayload, type SharedSite, type SharedSystem,
} from "@/lib/clientShare";
import type { ProviderListing } from "@/lib/providerDirectory";
import type { FeeTerms } from "@/lib/referral";

/**
 * The snapshot, taken now.
 *
 * Scoped on owner AND tenant, for the reason lib/fleetBriefData spells out at
 * length: ownership is not a scope, and a null tenant emits no predicate. A
 * caller with no resolved workspace gets null rather than every operator's
 * rows, on a path whose entire purpose is to write into somebody else's
 * database.
 */
export async function composePayload(opts: {
  orgId: number;
  tenantOrgId: number | null;
  operatorName: string;
  by: string;
  on: string;
  note: string;
}): Promise<SharePayload | null> {
  if (opts.tenantOrgId === null) return null;
  const [org] = await db.select().from(orgs).where(eq(orgs.id, opts.orgId));
  if (!org) return null;

  const rows = await db.select({
    id: instruments.id, externalId: instruments.externalId, model: instruments.model,
    category: instruments.category, siteId: instruments.siteId, location: instruments.location,
  }).from(instruments)
    .where(and(
      eq(instruments.ownerOrgId, opts.orgId),
      forTenant(instruments.tenantOrgId, opts.tenantOrgId),
    ))
    .orderBy(asc(instruments.externalId));

  const [siteRows, assetRows] = await Promise.all([
    db.select().from(orgSites)
      .where(and(eq(orgSites.orgId, opts.orgId), forTenant(orgSites.tenantOrgId, opts.tenantOrgId))),
    rows.length
      ? db.select({
          instrumentId: assets.instrumentId, kind: assets.kind, model: assets.model,
          serial: assets.serial, manufacturer: assets.manufacturer, sortOrder: assets.sortOrder,
        }).from(assets).where(inArray(assets.instrumentId, rows.map((r) => r.id)))
          .orderBy(asc(assets.sortOrder))
      : Promise.resolve([]),
  ]);

  const nameOf = new Map(siteRows.map((s) => [s.id, siteLabel(s)]));
  const sites: SharedSite[] = siteRows.filter((s) => !s.archived).map((s) => ({
    name: siteLabel(s), address: s.address,
    // The other shop has to physically get into the building, so how to do
    // that travels. It is the one contact detail that is about the WORK
    // rather than about the relationship.
    accessNotes: s.accessNotes, contactName: s.contactName,
    contactPhone: s.contactPhone, contactEmail: s.contactEmail,
  }));

  const systems: SharedSystem[] = rows.map((r) => ({
    sourceRef: r.externalId,
    model: r.model, category: r.category ?? "",
    siteName: (r.siteId !== null ? nameOf.get(r.siteId) : "") ?? "",
    location: r.location ?? "",
    modules: assetRows.filter((a) => a.instrumentId === r.id).map((a) => ({
      kind: a.kind ?? "", model: a.model ?? "",
      serial: a.serial ?? "", manufacturer: a.manufacturer ?? "",
    })),
  }));

  return {
    version: SHARE_VERSION,
    client: { name: org.name, kind: "client" },
    sites, systems,
    from: { operator: opts.operatorName, by: opts.by, on: opts.on },
    note: opts.note.trim().slice(0, 500),
  };
}

/**
 * Write an accepted share into the recipient's workspace.
 *
 * THE ONE WRITE THAT CROSSES. Every row it creates is stamped with the
 * RECIPIENT's tenant and parented to the recipient's operator, because from
 * this moment the copy is theirs: their client, their systems, theirs to edit,
 * rename and eventually delete. Nothing here points back at the sender's rows,
 * and nothing the sender does afterwards reaches them.
 *
 * Tags are minted fresh against what the recipient already uses, and the
 * sender's tag is recorded in source_ref - their shelf, their labels, and a
 * cross-reference so the two shops can name the same machine on the phone.
 */
export async function materialize(opts: {
  payload: SharePayload;
  destTenantOrgId: number;
  actor: string;
}): Promise<{ orgId: number; systems: number }> {
  const p = opts.payload;

  const [org] = await db.insert(orgs).values({
    name: p.client.name,
    kind: "client",
    // Parented to the RECIPIENT: that is what makes it their client, visible
    // in their org list and administrable by them.
    parentOrgId: opts.destTenantOrgId,
  }).returning();

  const siteIds = new Map<string, number>();
  if (p.sites.length) {
    const made = await db.insert(orgSites).values(p.sites.map((s) => ({
      tenantOrgId: opts.destTenantOrgId, orgId: org.id,
      name: s.name, address: s.address, accessNotes: s.accessNotes,
      contactName: s.contactName, contactPhone: s.contactPhone, contactEmail: s.contactEmail,
    }))).returning({ id: orgSites.id, name: orgSites.name });
    for (const m of made) siteIds.set(m.name, m.id);
  }

  // Every tag this workspace already uses, so a fresh one cannot collide.
  // instruments.external_id is unique across the whole table, not per tenant -
  // so this is checked globally, which is stricter than it needs to be and
  // exactly as strict as the constraint.
  const taken = (await db.select({ externalId: instruments.externalId }).from(instruments))
    .map((r) => r.externalId);

  let systems = 0;
  for (const s of p.systems) {
    const tag = freeTag(s.sourceRef, taken);
    taken.push(tag);
    const [inst] = await db.insert(instruments).values({
      tenantOrgId: opts.destTenantOrgId,
      externalId: tag,
      sourceRef: s.sourceRef,
      client: p.client.name,
      model: s.model,
      category: s.category,
      location: s.location,
      ownerOrgId: org.id,
      siteId: siteIds.get(s.siteName) ?? null,
      notes: provenanceLine(p),
    }).returning({ id: instruments.id });
    systems++;
    if (s.modules.length) {
      await db.insert(assets).values(s.modules.map((m, i) => ({
        tenantOrgId: opts.destTenantOrgId,
        instrumentId: inst.id,
        kind: m.kind, model: m.model, serial: m.serial, manufacturer: m.manufacturer,
        sortOrder: i,
      })));
    }
  }
  return { orgId: org.id, systems };
}

/** Every listing on the instance, for the directory. */
export async function listings(): Promise<ProviderListing[]> {
  const rows = await db.select({
    orgId: providerProfiles.orgId, listed: providerProfiles.listed,
    blurb: providerProfiles.blurb, services: providerProfiles.services,
    regions: providerProfiles.regions, contactName: providerProfiles.contactName,
    contactEmail: providerProfiles.contactEmail, contactPhone: providerProfiles.contactPhone,
    website: providerProfiles.website, name: orgs.name, isOperator: orgs.isOperator,
  }).from(providerProfiles).innerJoin(orgs, eq(orgs.id, providerProfiles.orgId));
  // Only operators. A listing on an org that has stopped running a workspace is
  // a shopfront with nobody behind it.
  return rows.filter((r) => r.isOperator).map((r) => ({
    orgId: r.orgId, name: r.name, listed: r.listed, blurb: r.blurb,
    services: r.services ?? [], regions: r.regions ?? [],
    contactName: r.contactName, contactEmail: r.contactEmail,
    contactPhone: r.contactPhone, website: r.website,
  }));
}

export type ShareRow = {
  id: number;
  status: string;
  /** What accepting costs. Frozen with the payload - see lib/referral. */
  terms: FeeTerms;
  /** What the recipient proposed instead, when they countered. Null when none. */
  counter: FeeTerms | null;
  counteredBy: string;
  note: string;
  createdBy: string;
  createdOn: string;
  otherName: string;
  payload: SharePayload | null;
  sourceOrgId: number;
  destOrgId: number | null;
};

/** Shares this workspace SENT, and shares it was OFFERED. */
export async function sharesFor(tenantOrgId: number | null): Promise<{
  sent: ShareRow[]; inbox: ShareRow[];
}> {
  if (tenantOrgId === null) return { sent: [], inbox: [] };
  const [sent, inbox] = await Promise.all([
    db.select().from(clientShares).where(eq(clientShares.tenantOrgId, tenantOrgId))
      .orderBy(asc(clientShares.status), asc(clientShares.id)),
    // Somebody else's rows, read by the one predicate that makes them ours to
    // see: they are addressed to us.
    db.select().from(clientShares).where(eq(clientShares.toOrgId, tenantOrgId))
      .orderBy(asc(clientShares.status), asc(clientShares.id)),
  ]);
  const orgIds = [...new Set([
    ...sent.map((r) => r.toOrgId), ...inbox.map((r) => r.tenantOrgId),
  ].filter((x): x is number => x !== null))];
  const names = new Map(orgIds.length
    ? (await db.select({ id: orgs.id, name: orgs.name }).from(orgs).where(inArray(orgs.id, orgIds)))
      .map((o) => [o.id, o.name])
    : []);
  const shape = (r: typeof clientShares.$inferSelect, otherId: number | null): ShareRow => ({
    id: r.id, status: r.status, note: r.note, createdBy: r.createdBy,
    terms: {
      kind: r.feeKind, feeCents: r.feeCents, feeBps: r.feeBps,
      windowMonths: r.feeWindowMonths, note: r.feeNote,
      minCents: r.feeMinCents, maxCents: r.feeMaxCents,
    },
    counter: r.counterKind
      ? {
        kind: r.counterKind, feeCents: r.counterCents, feeBps: r.counterBps,
        windowMonths: r.counterWindowMonths, note: r.counterNote,
        minCents: r.counterMinCents, maxCents: r.counterMaxCents,
      }
      : null,
    counteredBy: r.counteredBy,
    createdOn: r.createdAt.toISOString().slice(0, 10),
    otherName: (otherId !== null ? names.get(otherId) : "") ?? "another service company",
    payload: parsePayload(r.payload),
    sourceOrgId: r.sourceOrgId, destOrgId: r.destOrgId,
  });
  return {
    sent: sent.map((r) => shape(r, r.toOrgId)),
    inbox: inbox.map((r) => shape(r, r.tenantOrgId)),
  };
}
