// Composing a client handover, and materializing one that was accepted.
// The rules are lib/clientShare and stay pure; this is the fetching and the
// one write that crosses a workspace boundary in the whole application.

import { and, asc, eq, inArray, ne, or } from "drizzle-orm";
import { db } from "@/db";
import {
  assets, catalogRefs, clientShares, instruments, invoiceLines, invoices, orgSites, orgs,
  parts, pmSchedules, providerProfiles,
} from "@/db/schema";
import { forTenant } from "@/lib/tenancy";
import { siteLabel } from "@/lib/sites";
import { refsForUnits } from "@/lib/catalogRefs";
import { isPublishable } from "@/lib/provenance";
import {
  freeTag, parsePayload, provenanceLine, redactPayload, SHARE_VERSION,
  type SharePayload, type SharedPart, type SharedPm, type SharedPricing, type SharedRef,
  type SharedSite, type SharedSystem,
} from "@/lib/clientShare";
import type { ProviderListing } from "@/lib/providerDirectory";
import type { FeeTerms } from "@/lib/referral";

/**
 * WHAT THIS ACCOUNT HAS BILLED, when the sender chose to send it.
 *
 * Read straight off the sender's own invoices and reduced to a summary before
 * it leaves: a total and a visit count per calendar year, plus the hour rate
 * that appears most often on labour lines. No documents, no line items, no
 * dates money arrived, nothing about whether they pay late - see SharedPricing
 * in lib/clientShare for why this is the one money field in the payload and
 * what it is deliberately not.
 *
 * Drafts and voids are left out for the reason lib/referralData gives: neither
 * is money anybody asked for, and an unsent draft in a sale figure is a number
 * the buyer would price against and never see again.
 */
export async function composePricing(opts: {
  orgId: number;
  tenantOrgId: number | null;
}): Promise<SharedPricing | null> {
  if (opts.tenantOrgId === null) return null;
  const inv = await db.select({
    id: invoices.id, issuedOn: invoices.issuedOn, workOrderId: invoices.workOrderId,
  }).from(invoices).where(and(
    eq(invoices.tenantOrgId, opts.tenantOrgId),
    eq(invoices.orgId, opts.orgId),
    ne(invoices.status, "draft"),
    ne(invoices.status, "void"),
  ));
  const sent = inv.filter((r) => r.issuedOn.length >= 4);
  if (!sent.length) return null;

  const lines = await db.select({
    invoiceId: invoiceLines.invoiceId, kind: invoiceLines.kind, qty: invoiceLines.qty,
    unitCents: invoiceLines.unitCents, covered: invoiceLines.covered,
  }).from(invoiceLines).where(inArray(invoiceLines.invoiceId, sent.map((r) => r.id)));

  // The same arithmetic an invoice total uses - qty is thousandths, a covered
  // line prices at zero because the contract already paid for it.
  const totalOf = new Map<number, number>();
  for (const l of lines) {
    const add = l.covered ? 0 : Math.round((l.qty / 1000) * l.unitCents);
    totalOf.set(l.invoiceId, (totalOf.get(l.invoiceId) ?? 0) + add);
  }

  const byYear = new Map<string, { billedCents: number; visits: Set<string> }>();
  for (const r of sent) {
    const y = r.issuedOn.slice(0, 4);
    const bucket = byYear.get(y) ?? { billedCents: 0, visits: new Set<string>() };
    bucket.billedCents += totalOf.get(r.id) ?? 0;
    // A visit is a job, not a bill: several invoices against one work order are
    // one trip, and an invoice with no work order behind it is counted once on
    // its own. Getting this wrong flatters the account, which is the direction
    // that costs the buyer money.
    bucket.visits.add(r.workOrderId !== null ? `w${r.workOrderId}` : `i${r.id}`);
    byYear.set(y, bucket);
  }

  /*
   * The rate somebody would quote against: the labour price that shows up on
   * the most lines, not the average and not the highest. An average is dragged
   * around by one long warranty job at zero, and the highest is the emergency
   * call-out nobody is charged twice a year.
   */
  const seen = new Map<number, number>();
  for (const l of lines) {
    if (l.kind !== "labor" || l.unitCents <= 0) continue;
    seen.set(l.unitCents, (seen.get(l.unitCents) ?? 0) + 1);
  }
  const laborRateCents = [...seen.entries()]
    .sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 0;

  return {
    years: [...byYear.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 20)
      .map(([year, v]) => ({ year, billedCents: v.billedCents, visits: v.visits.size })),
    laborRateCents,
    note: "",
  };
}

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
          id: assets.id,
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

  // The rest of the record. Everything below is keyed to the fleet we just
  // read, which is already scoped on owner AND tenant - so a part cannot
  // arrive from a machine this caller was not allowed to see.
  const instIds = rows.map((r) => r.id);
  const tagOf = new Map(rows.map((r) => [r.id, r.externalId]));
  /*
   * Every module, by id, to the machine it is on and its position in that
   * machine's list - the same order composePayload emits them in below and the
   * same order materialize writes them in. It is what lets a schedule filed on
   * the PUMP travel as a schedule on the pump.
   */
  const moduleAt = new Map<number, { instrumentId: number; index: number }>();
  for (const r of rows) {
    assetRows.filter((a) => a.instrumentId === r.id)
      .forEach((a, index) => moduleAt.set(a.id, { instrumentId: r.id, index }));
  }
  const assetIds = [...moduleAt.keys()];

  const [pmRows, partRows, refRowsAll] = await Promise.all([
    /*
     * Scoped on the FLEET, not on the stamp. A schedule hangs off a system or
     * a module, and a record hanging off one of those takes that record's
     * tenant - the rule tests/tenantStamp spells out - so the instrument list
     * above, which is itself scoped on owner AND tenant, is the scope here.
     * Reading the stamp as well would be stricter in appearance and wrong in
     * practice: rows written before pm_schedules carried a stamp have a null
     * in that column, and a null is not a scope - it would silently drop real
     * maintenance out of a hand-off the page had already advertised.
     */
    instIds.length
      ? db.select({
          instrumentId: pmSchedules.instrumentId, assetId: pmSchedules.assetId,
          title: pmSchedules.title,
          everyDays: pmSchedules.everyDays, nextDue: pmSchedules.nextDue,
          lastDone: pmSchedules.lastDone, paused: pmSchedules.paused,
        }).from(pmSchedules)
          .where(or(
            inArray(pmSchedules.instrumentId, instIds),
            assetIds.length ? inArray(pmSchedules.assetId, assetIds) : undefined,
          ))
          .orderBy(asc(pmSchedules.nextDue))
      : Promise.resolve([]),
    // parts carries no tenant stamp - a part belongs to its instrument and
    // dies with it - so the instrument list above IS the scope.
    instIds.length
      ? db.select({
          instrumentId: parts.instrumentId, name: parts.name,
          partNumber: parts.partNumber, qty: parts.qty,
          installedAt: parts.installedAt, status: parts.status,
        }).from(parts).where(inArray(parts.instrumentId, instIds))
          .orderBy(asc(parts.installedAt))
      : Promise.resolve([]),
    db.select().from(catalogRefs)
      .where(forTenant(catalogRefs.tenantOrgId, opts.tenantOrgId))
      .orderBy(asc(catalogRefs.assetType), asc(catalogRefs.model), asc(catalogRefs.id))
      .catch(() => []),
  ]);

  /* Bounded to the same numbers parsePayload enforces on the way back in.
     Without that a very large fleet would freeze a payload whose tail the
     reader silently drops, and the sender's audit line would name a figure
     nobody ever receives. Cut here, and the offer, the page and what
     materialize writes are all the same list. */
  const pms: SharedPm[] = pmRows
    .map((r): SharedPm | null => {
      // A module schedule resolves through the module to its machine; a system
      // schedule already names one. Anything that resolves to neither is not
      // on this fleet and does not travel.
      const on = r.assetId !== null ? moduleAt.get(r.assetId) : null;
      const instrumentId = on?.instrumentId ?? r.instrumentId;
      if (r.paused || instrumentId === null || !tagOf.has(instrumentId)) return null;
      return {
        sourceRef: tagOf.get(instrumentId)!,
        moduleIndex: on ? on.index : null,
        title: r.title, everyDays: r.everyDays,
        nextDue: r.nextDue, lastDone: r.lastDone,
      };
    })
    .filter((x) => x !== null)
    .slice(0, 500);

  // Fitted parts only. A request nobody ordered and an order still in transit
  // are the sender's business, not a history of this fleet.
  const partsOut: SharedPart[] = partRows
    .filter((r) => r.status === "Installed" && r.instrumentId !== null)
    .slice(0, 2000)
    .map((r) => ({
      sourceRef: tagOf.get(r.instrumentId!) ?? "",
      name: r.name, partNumber: r.partNumber,
      qty: r.qty, installedAt: r.installedAt,
    }));

  /*
   * References are filed on a MODEL, not on a machine, so what travels is
   * whatever covers the equipment in this fleet - and only what the shop is
   * entitled to pass on. lib/provenance already decides that question for the
   * licensed library, and a hand-off is the same question with a different
   * buyer: our own work and our own restatement of facts may go, a
   * manufacturer's words may not, and unreviewed counts as not ours. The
   * inventory the recipient is shown is counted off this list, so what an
   * offer advertises is exactly what acceptance delivers.
   */
  const units = assetRows.map((a) => ({ kind: a.kind ?? "", model: a.model ?? "" }));
  const refs: SharedRef[] = refsForUnits(
    refRowsAll.filter((r) => isPublishable(r.provenance)),
    units,
  ).slice(0, 500).map((r) => ({
    assetType: r.assetType, model: r.model, kind: r.kind,
    title: r.title, url: r.url, body: r.body,
  }));

  return {
    version: SHARE_VERSION,
    client: { name: org.name, kind: "client" },
    sites, systems,
    pms, parts: partsOut, refs,
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
  // The sender's tag to the id it landed on here, so the record that hangs off
  // a machine can find the machine after it was renamed.
  const idOf = new Map<string, number>();
  /** And its modules, in payload order - see SharedPm.moduleIndex. */
  const modulesOf = new Map<string, number[]>();
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
    if (s.sourceRef) idOf.set(s.sourceRef, inst.id);
    if (s.modules.length) {
      // Inserted in payload order and returned in it, which is what makes
      // SharedPm.moduleIndex resolvable on this side.
      const made = await db.insert(assets).values(s.modules.map((m, i) => ({
        tenantOrgId: opts.destTenantOrgId,
        instrumentId: inst.id,
        kind: m.kind, model: m.model, serial: m.serial, manufacturer: m.manufacturer,
        sortOrder: i,
      }))).returning({ id: assets.id, sortOrder: assets.sortOrder });
      if (s.sourceRef) {
        modulesOf.set(s.sourceRef,
          made.slice().sort((a, b) => a.sortOrder - b.sortOrder).map((a) => a.id));
      }
    }
  }

  // The maintenance rhythm, arriving live: a schedule that landed paused would
  // be a list of jobs nobody is ever told about, which is worse than not
  // sending it. Dates come across as they stood - a cycle that was overdue at
  // the sender is overdue here, and that is the fact the new shop needs on
  // Monday rather than a clock reset to make the handover look tidy.
  const pmRows = (p.pms ?? [])
    .map((m) => ({
      id: idOf.get(m.sourceRef),
      // Back onto the module it was on, when it was on one and that module
      // travelled. Null otherwise, and then it hangs on the system: a pump
      // schedule landing on the instrument is a job somebody can still do, and
      // landing on nothing is not - see SharedPm.moduleIndex.
      assetId: m.moduleIndex === null || m.moduleIndex === undefined ? null
        : (modulesOf.get(m.sourceRef) ?? [])[m.moduleIndex] ?? null,
      m,
    }))
    .filter((x): x is { id: number; assetId: number | null; m: (typeof x)["m"] } =>
      x.id !== undefined);
  if (pmRows.length) {
    await db.insert(pmSchedules).values(pmRows.map(({ id, assetId, m }) => ({
      tenantOrgId: opts.destTenantOrgId,
      // BOTH ids, when it is on a module: that is the shape resolveTarget
      // writes for a module tagged from a system page, and it is what puts the
      // job on the system's maintenance list as well as the module's.
      instrumentId: id,
      assetId,
      title: m.title,
      everyDays: m.everyDays,
      nextDue: m.nextDue,
      lastDone: m.lastDone,
      body: provenanceLine(p),
    })));
  }

  // The parts history, as history: every line lands Installed with the date it
  // was fitted and no cost, because none crossed. A blank cost on a fitted part
  // reads as "we do not know what this cost", which is the truth.
  const partRows = (p.parts ?? [])
    .map((r) => ({ id: idOf.get(r.sourceRef), r }))
    .filter((x): x is { id: number; r: (typeof x)["r"] } => x.id !== undefined);
  if (partRows.length) {
    await db.insert(parts).values(partRows.map(({ id, r }) => ({
      instrumentId: id,
      name: r.name,
      partNumber: r.partNumber,
      qty: r.qty,
      installedAt: r.installedAt,
      status: "Installed",
      note: provenanceLine(p),
    })));
  }

  /*
   * The reference library, filed on models rather than on this client's
   * machines - so it outlives the account and is the part of a hand-off worth
   * the most a year later.
   *
   * Two rules. Skipped when the recipient already files something under the
   * same type, model and title, because a hand-off should not fill somebody's
   * catalog with second copies of what they wrote themselves. And landing
   * UNREVIEWED whatever the sender asserted: provenance is a claim about who
   * owns the words, the sender's answer was about the sender's right to pass
   * it on, and nobody here has decided whether this shop may license it out
   * again. '' is the default that keeps it out of anything licensed until a
   * person says otherwise - see lib/provenance.
   */
  if ((p.refs ?? []).length) {
    const have = new Set((await db.select({
      assetType: catalogRefs.assetType, model: catalogRefs.model, title: catalogRefs.title,
    }).from(catalogRefs).where(eq(catalogRefs.tenantOrgId, opts.destTenantOrgId)))
      .map((r) => `${r.assetType}|${r.model}|${r.title}`.toLowerCase()));
    const fresh = (p.refs ?? [])
      .filter((r) => !have.has(`${r.assetType}|${r.model}|${r.title}`.toLowerCase()));
    if (fresh.length) {
      await db.insert(catalogRefs).values(fresh.map((r) => ({
        tenantOrgId: opts.destTenantOrgId,
        assetType: r.assetType, model: r.model, kind: r.kind,
        title: r.title, url: r.url, body: r.body,
        createdBy: `${p.from.operator} (handed over)`,
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
  /** True while the recipient is seeing a redacted view of it. */
  blind: boolean;
  /**
   * An INVITE - offered to an email rather than to a workspace, because the
   * shop has no account here yet. See lib/handoff.
   */
  isInvite: boolean;
  /** Invites only: whether they have opened the link, and when it lapses. */
  openedAt: Date | null;
  expiresOn: string;
  /**
   * The link itself, on the SENDER's own row only.
   *
   * They made it, and email is the one part of this that reliably fails - a
   * spam filter between two service companies is the difference between a
   * conversion and silence. So the sender can always copy the link and send it
   * the way they were going to telephone anyway. Never on an inbox row: the
   * token is the authorization, and a recipient has no use for one.
   */
  inviteToken: string;
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
    blind: r.blind && r.status !== "accepted",
    isInvite: r.toOrgId === null && r.toEmail !== "",
    openedAt: r.openedAt,
    expiresOn: r.expiresOn,
    inviteToken: "",
    createdOn: r.createdAt.toISOString().slice(0, 10),
    /* An invite has no workspace to name, so it is named by the address it
       went to - which is also the only thing the sender knows about them. */
    otherName: (otherId !== null ? names.get(otherId) : "")
      || r.toEmail || "another service company",
    payload: parsePayload(r.payload),
    sourceOrgId: r.sourceOrgId, destOrgId: r.destOrgId,
  });
  /*
   * Redacted on the way to the RECIPIENT and never to the sender - it is their
   * client, and a blind offer that hid the name from the person who wrote it
   * would be nonsense. Done here, at the edge, so nothing downstream has to
   * remember: whatever reaches their screen is already blind.
   */
  const blindly = (r: ShareRow): ShareRow =>
    (r.blind && r.payload ? { ...r, payload: redactPayload(r.payload) } : r);

  return {
    // The token only ever leaves on the sender's own rows - see the field.
    sent: sent.map((r) => ({ ...shape(r, r.toOrgId), inviteToken: r.inviteToken })),
    inbox: inbox.map((r) => blindly(shape(r, r.tenantOrgId))),
  };
}
