// Who can be @mentioned on a record - and it must be exactly who can READ it.
//
// Two rules that had drifted apart. The notifier's audience was built from
// system_shares alone, so a client that OWNS a system - and can open it, and
// is reading the note - could never be mentioned on it. The asset side of the
// same function already counted owners; the system side did not, and nothing
// made the two disagree loudly, because the only symptom was a notification
// that quietly never arrived.
//
// It stopped being quiet the moment the composer grew a dropdown: offering a
// name that does nothing is worse than offering no names at all. So the list
// somebody picks from and the list the notifier will reach are now the same
// list, computed here once.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { assetShares, assets, clientAllowlist, instruments, systemShares } from "@/db/schema";
import { houseEmails } from "@/lib/house";

/** Where a note lives. One of the two ids is set. */
export type NoteRecord = { instrumentId: number | null; assetId: number | null };

/**
 * Exact addresses on the allowlist for these orgs. `@domain` rules are doors,
 * not people: nobody can be mentioned by one, so they are left out.
 */
async function peopleOfOrgs(orgIds: number[]): Promise<string[]> {
  const ids = [...new Set(orgIds.filter((id): id is number => id !== null && id !== undefined))];
  if (!ids.length) return [];
  const rows = await db.select().from(clientAllowlist).where(inArray(clientAllowlist.orgId, ids));
  return rows.filter((e) => !e.entry.trim().startsWith("@")).map((e) => e.entry.trim().toLowerCase());
}

/**
 * Every address that can read this record: the servicing company's own staff,
 * the organization that owns it, and any organization it is shared with.
 */
export async function readersOf(rec: NoteRecord): Promise<Set<string>> {
  if (rec.instrumentId !== null) {
    const [inst] = await db.select({ ownerOrgId: instruments.ownerOrgId, tenantOrgId: instruments.tenantOrgId })
      .from(instruments).where(eq(instruments.id, rec.instrumentId));
    const [staff, shares] = await Promise.all([
      houseEmails(inst?.tenantOrgId ?? null),
      db.select({ orgId: systemShares.orgId }).from(systemShares)
        .where(eq(systemShares.instrumentId, rec.instrumentId)),
    ]);
    const orgs = [...(inst?.ownerOrgId != null ? [inst.ownerOrgId] : []), ...shares.map((s) => s.orgId)];
    return new Set([...staff, ...(await peopleOfOrgs(orgs))].map((e) => e.toLowerCase()));
  }
  if (rec.assetId === null) return new Set();
  const [a] = await db.select({ ownerOrgId: assets.ownerOrgId, tenantOrgId: assets.tenantOrgId })
    .from(assets).where(eq(assets.id, rec.assetId));
  const [staff, shares] = await Promise.all([
    houseEmails(a?.tenantOrgId ?? null),
    db.select({ orgId: assetShares.orgId }).from(assetShares).where(eq(assetShares.assetId, rec.assetId)),
  ]);
  const orgs = [...(a?.ownerOrgId != null ? [a.ownerOrgId] : []), ...shares.map((s) => s.orgId)];
  return new Set([...staff, ...(await peopleOfOrgs(orgs))].map((e) => e.toLowerCase()));
}

/**
 * The directory narrowed to people this record's readers - what the composer's
 * dropdown offers. Anybody without an email is dropped: a name that cannot be
 * written to is a name that cannot be notified.
 */
export async function mentionableOn<T extends { email: string }>(
  directory: T[], rec: NoteRecord,
): Promise<T[]> {
  const allowed = await readersOf(rec);
  return directory.filter((m) => m.email && allowed.has(m.email.trim().toLowerCase()));
}
