// The cross-workspace half of search: an exact serial number resolves to an
// instrument anywhere on the platform, including ones the viewer cannot see.
// Scoped search finds your own things; this finds the *identity* of a unit and
// offers the ways in - request access, claim ownership, or view a public
// listing. Kept separate from the page so /search can call it as one step.
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { accessRequests, assets, instruments } from "@/db/schema";
import type { SessionUser } from "@/lib/authz";
import { assetAccess } from "@/lib/tenancy";
import { normalizeSerial, serialSearchable } from "@/lib/serial";

export type OutsideMatch = {
  /** Present when the unit sits on a system - the target of an access request. */
  instrumentId: number | null;
  desc: string;
  requested: boolean;
  /** Set when its owner put it on the market: the public listing to link. */
  listing: { token: string; note: string } | null;
};

/**
 * Exact, case-insensitive serial match against units the viewer CANNOT see.
 * Anything already visible is left to the ordinary search results. Hidden shelf
 * spares stay undisclosed unless their owner listed them for sale - the listing
 * is the disclosure.
 */
export async function findOutsideMatches(user: SessionUser, query: string): Promise<OutsideMatch[]> {
  if (!serialSearchable(query)) return [];
  const norm = normalizeSerial(query);
  const rows = await db.select().from(assets).where(sql`lower(btrim(${assets.serial})) = ${norm}`);
  if (!rows.length) return [];

  const hidden: typeof rows = [];
  for (const a of rows) {
    if (!(await assetAccess(user, a.id)).see) hidden.push(a);
  }
  if (!hidden.length) return [];

  const systemIds = [...new Set(hidden.map((a) => a.instrumentId).filter((x): x is number => x !== null))];
  const [sysRows, pending] = await Promise.all([
    systemIds.length
      ? db.select({ id: instruments.id, forSale: instruments.forSale, saleNote: instruments.saleNote, listingToken: instruments.listingToken })
          .from(instruments).where(inArray(instruments.id, systemIds))
      : [],
    user.orgId !== null && systemIds.length
      ? db.select({ instrumentId: accessRequests.instrumentId }).from(accessRequests).where(and(
          eq(accessRequests.orgId, user.orgId), eq(accessRequests.status, "pending"),
          inArray(accessRequests.instrumentId, systemIds)))
      : [],
  ]);
  const sysById = new Map(sysRows.map((s) => [s.id, s]));
  const pendingIds = new Set(pending.map((p) => p.instrumentId));

  const out: OutsideMatch[] = [];
  const seenSystems = new Set<number>();
  for (const a of hidden) {
    const desc = `${a.kind}${a.model ? ` — ${a.model}` : ""}`;
    if (a.instrumentId !== null) {
      if (seenSystems.has(a.instrumentId)) continue; // one card per system
      seenSystems.add(a.instrumentId);
      const s = sysById.get(a.instrumentId);
      out.push({
        instrumentId: a.instrumentId, desc, requested: pendingIds.has(a.instrumentId),
        listing: s?.forSale && s.listingToken ? { token: s.listingToken, note: s.saleNote } : null,
      });
    } else if (a.forSale && a.listingToken) {
      out.push({ instrumentId: null, desc, requested: false, listing: { token: a.listingToken, note: a.saleNote } });
    }
  }
  return out;
}
