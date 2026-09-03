/**
 * Turn today's access rows into grants on the open epoch.
 *   DATABASE_URL=... npx tsx scripts/backfill-grants.ts [--apply]
 *
 * Dry by default. Idempotent on (epoch, grantee, kind): re-running does not
 * stack duplicates.
 *
 * Three sources, three kinds:
 *   system_shares  -> a `service` grant on the machine's open epoch. This is
 *                     the row that already means "this org may work here".
 *   provider_links -> a `service` grant on every open epoch in that tenant's
 *                     fleet. A fleet link is not per-machine, so it fans out;
 *                     scoped so Phase 8 can tell it from a per-machine grant.
 *   share_links    -> a `view` grant with ends_at = expires_on, for the kinds
 *                     that actually expose a record. An invoice link exposes
 *                     an invoice and is nobody's business here.
 *
 * EVERYTHING GOES ON THE OPEN EPOCH and nothing is invented for closed ones. A
 * share row carries no history: it cannot say which previous holder let an org
 * in, and dating it into a closed epoch would manufacture a party to a tenure
 * that has already been sealed and shipped to somebody.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../src/db";
import {
  custodyEpochs, grants, instruments, providerLinks, shareLinks, systemShares,
} from "../src/db/schema";

/** Link kinds that put a system's record in front of somebody. */
const RECORD_KINDS = ["fleet", "files"];

export async function main() {
  const apply = process.argv.includes("--apply");

  const open = await db.select({
    id: custodyEpochs.id, instrumentId: custodyEpochs.instrumentId, custodianOrgId: custodyEpochs.custodianOrgId,
  }).from(custodyEpochs).where(eq(custodyEpochs.closeKind, "open"));
  if (!open.length) {
    console.log("[grants] no open epochs - run scripts/backfill-epochs.ts first");
    return;
  }
  const epochOf = new Map(open.map((e) => [e.instrumentId, e]));

  const seen = new Set(
    (await db.select({ epochId: grants.epochId, granteeOrgId: grants.granteeOrgId, kind: grants.kind }).from(grants))
      .map((g) => `${g.epochId}|${g.granteeOrgId}|${g.kind}`),
  );
  type Row = typeof grants.$inferInsert;
  const pending: Row[] = [];
  const add = (row: Row) => {
    const key = `${row.epochId}|${row.granteeOrgId}|${row.kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    pending.push(row);
  };

  const shares = await db.select().from(systemShares);
  for (const s of shares) {
    const epoch = epochOf.get(s.instrumentId);
    if (!epoch) continue;
    add({
      instrumentId: s.instrumentId, epochId: epoch.id, granteeOrgId: s.orgId,
      grantedByOrgId: epoch.custodianOrgId, kind: "service",
      scope: { from: "system_shares", access: s.access },
      startsAt: s.createdAt, createdBy: s.addedBy,
    });
  }
  const fromShares = pending.length;

  const links = await db.select().from(providerLinks);
  for (const link of links) {
    if (link.tenantOrgId === null) continue;
    const fleet = await db.select({ id: instruments.id }).from(instruments)
      .where(eq(instruments.tenantOrgId, link.tenantOrgId));
    for (const inst of fleet) {
      const epoch = epochOf.get(inst.id);
      if (!epoch) continue;
      add({
        instrumentId: inst.id, epochId: epoch.id, granteeOrgId: link.providerOrgId,
        grantedByOrgId: epoch.custodianOrgId, kind: "service",
        // Marked so Phase 8 can tell a fleet-wide arrangement from somebody
        // deliberately let onto one machine. They are not the same promise.
        scope: { from: "provider_links", fleet: true },
        startsAt: link.createdAt, createdBy: link.createdBy,
      });
    }
  }
  const fromLinks = pending.length - fromShares;

  const viewers = await db.select().from(shareLinks)
    .where(and(inArray(shareLinks.kind, RECORD_KINDS), sql`${shareLinks.revokedAt} IS NULL`));
  for (const link of viewers) {
    if (link.orgId === null) continue;
    // A fleet link speaks to an org about its whole fleet, so it lands on every
    // machine that org holds - which is exactly what the token shows.
    for (const epoch of open) {
      if (epoch.custodianOrgId !== link.orgId) continue;
      add({
        instrumentId: epoch.instrumentId, epochId: epoch.id, granteeOrgId: link.orgId,
        grantedByOrgId: epoch.custodianOrgId, kind: "view",
        scope: { from: "share_links", token: link.token, label: link.label },
        startsAt: link.createdAt,
        // A link with a date on it is a grant with a clock. Noon so the day
        // survives every timezone's midnight, the way the rest of the app does.
        endsAt: link.expiresOn ? new Date(`${link.expiresOn}T12:00:00Z`) : null,
      });
    }
  }
  const fromLinksView = pending.length - fromShares - fromLinks;

  if (apply && pending.length) {
    for (const row of pending) await db.insert(grants).values(row);
  }

  console.log(`[grants] ${apply ? "wrote" : "would write"} ${pending.length} grant(s)`);
  console.log(`[grants]   system_shares: ${fromShares}`);
  console.log(`[grants]   provider_links: ${fromLinks} (fleet-scoped)`);
  console.log(`[grants]   share_links: ${fromLinksView} (view, expiring)`);
  if (!apply) console.log("[grants] dry run; pass --apply to write");
}

// Auto-runs when you run it, and stays quiet when a test imports it to
// drive main() against a database of its own. A backfill nobody can
// exercise is a backfill nobody knows the behaviour of.
if (!process.env.VITEST) main().catch((e) => { console.error("[grants] failed:", e); process.exit(1); });
