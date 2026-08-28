// The read behind the fleet brief. The rules are lib/fleetBrief and stay pure.
//
// THE TENANT GUARD IS THE POINT OF THIS FILE.
//
// `eq(instruments.ownerOrgId, orgId)` looks like a scope and is not one. A
// system owned by an organization can carry ANOTHER operator's stamp - that is
// what makes a shared client work, and setSystemOwner and shareSystem both
// allow it - so filtering on the owner alone would let one workspace compose a
// brief out of another workspace's records about the same client. And the usual
// second half of the predicate cannot save it either: forTenant(col, null)
// emits NO predicate at all, so a caller who arrives with a null tenant gets
// every operator's rows rather than none.
//
// So this refuses instead. A non-platform caller with no resolved tenant is a
// bug, and the honest response to a bug on a path that composes a document to
// send OUTSIDE the company is an error, not a best guess.

import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { agreements, assets, instruments, orgSites, tasks } from "@/db/schema";
import { forTenant } from "@/lib/tenancy";
import { systemLabel } from "@/lib/systemLabel";
import { siteLabel } from "@/lib/sites";
import { clientState } from "@/lib/clientView";
import { coverageBadge, coverageOf, type CoverageAgreement } from "@/lib/coverage";
import { providerNameOf, providerNames } from "@/lib/providers";
import { BLOCKED_STAGE } from "@/lib/stages";
import type { FleetRow } from "@/lib/fleetBrief";

/**
 * One client's systems, as a peer may see them.
 *
 * `tenantOrgId` is REQUIRED and null means "platform staff, deliberately
 * unscoped" - the caller has to have decided which, because the difference
 * between the two is the difference between a support session and a leak. Every
 * caller in the app passes readTenant(user) and checks mayAdminOrg first.
 *
 * `only` narrows to a frozen set of ids - what a share link carries - and is
 * intersected with the scope rather than trusted: a share names systems, it
 * does not grant them.
 */
export async function fleetRowsFor(opts: {
  orgId: number;
  tenantOrgId: number | null;
  today: string;
  operatorName: string;
  only?: number[];
}): Promise<FleetRow[]> {
  const scope = forTenant(instruments.tenantOrgId, opts.tenantOrgId);
  const rows = await db.select({
    id: instruments.id, externalId: instruments.externalId, model: instruments.model,
    category: instruments.category, siteId: instruments.siteId,
    location: instruments.location, stages: instruments.stages,
  }).from(instruments)
    .where(and(eq(instruments.ownerOrgId, opts.orgId), scope))
    .orderBy(asc(instruments.externalId));

  // The share's frozen ids narrow the scope; they never widen it. A system
  // handed to another operator since the link was minted drops out here rather
  // than riding along on a token nobody has revoked.
  const mine = opts.only ? rows.filter((r) => opts.only!.includes(r.id)) : rows;
  if (mine.length === 0) return [];
  const ids = mine.map((r) => r.id);

  const [assetRows, siteRows, agreementRows, openWork] = await Promise.all([
    db.select({
      instrumentId: assets.instrumentId, kind: assets.kind, model: assets.model,
      serial: assets.serial, manufacturer: assets.manufacturer, sortOrder: assets.sortOrder,
    }).from(assets).where(inArray(assets.instrumentId, ids)).orderBy(asc(assets.sortOrder)),
    db.select({ id: orgSites.id, name: orgSites.name, address: orgSites.address })
      .from(orgSites).where(eq(orgSites.orgId, opts.orgId)),
    // Every contract on this client, ours and anybody's - a system the
    // manufacturer covers must read as covered, or the brief tells a peer the
    // machine is free when it is not (see lib/coverage coverageSummary).
    db.select({
      id: agreements.id, title: agreements.title, number: agreements.number,
      status: agreements.status, startsOn: agreements.startsOn, endsOn: agreements.endsOn,
      renewNoticeDays: agreements.renewNoticeDays, instrumentIds: agreements.instrumentIds,
      providerOrgId: agreements.providerOrgId,
    }).from(agreements)
      .where(and(eq(agreements.orgId, opts.orgId), eq(agreements.kind, "contract"))),
    db.select({ instrumentId: tasks.instrumentId, state: tasks.state, dueDate: tasks.dueDate })
      .from(tasks).where(inArray(tasks.instrumentId, ids)),
  ]);

  const names = await providerNames(agreementRows);
  const cov: CoverageAgreement[] = agreementRows.map((r) => ({
    ...r, providerName: providerNameOf(r.providerOrgId, names),
  }));
  const siteName = new Map(siteRows.map((s) => [s.id, siteLabel(s)]));

  return mine.map((r) => {
    const theirs = assetRows.filter((a) => a.instrumentId === r.id);
    const c = coverageOf(r.id, cov, opts.today, opts.operatorName);
    const pmDue = openWork.some((t) =>
      t.instrumentId === r.id && t.state !== "Done" && !!t.dueDate && t.dueDate <= opts.today);
    return {
      externalId: r.externalId,
      label: systemLabel(r, theirs),
      category: r.category ?? "",
      siteName: (r.siteId !== null ? siteName.get(r.siteId) : "") || r.location || "",
      modules: theirs.map((a) => ({
        kind: a.kind ?? "", model: a.model ?? "",
        serial: a.serial ?? "", manufacturer: a.manufacturer ?? "",
      })),
      /*
       * Severity comes from OPEN work only, and this deliberately reads no
       * severity column: the brief says "In service" or "Down", never why. A
       * peer needs to know whether the machine runs; the story of what is
       * wrong with it is the client's, and telling it is not ours to do.
       */
      state: clientState({
        openSeverities: [], stages: r.stages ?? [], pmDue,
      }),
      coverage: c.state,
      coverageBadge: coverageBadge(c),
    };
  });
}

/** Refuse rather than guess: see the header. Returns the reason, or null. */
export function scopeProblem(tenantOrgId: number | null, isPlatformStaff: boolean): string | null {
  if (tenantOrgId === null && !isPlatformStaff) {
    return "Your workspace could not be resolved, so nothing can be briefed out of it.";
  }
  return null;
}
