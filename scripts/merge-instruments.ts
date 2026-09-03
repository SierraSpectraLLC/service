/**
 * Fold duplicate instrument rows into the machine's canonical row.
 *   DATABASE_URL=... npx tsx scripts/merge-instruments.ts --group <canonicalId> [--apply]
 *
 * RUN THE REPORT FIRST (scripts/dedupe-instruments.ts) and run this on a Neon
 * branch before main. One group per invocation, named by its canonical row,
 * because each merge is a decision somebody made about that machine.
 *
 * WHAT IT DOES. Every child row - tasks, jobs, files, parts, schedules,
 * verdicts, shares, grants, handoffs, the lot - is re-pointed at the canonical
 * row. The duplicates are ARCHIVED, never deleted, and each one's tag is kept
 * as the org_instrument_tags entry for the workspace that used it, so "their
 * EP-001 is our NW-114" survives with one row.
 *
 * THE CHAIN. system_events cannot be re-pointed by UPDATE (the append-only
 * trigger forbids it) and two chains cannot simply be concatenated (each has
 * a genesis link and the unique on (instrument_id, prev_hash) refuses a
 * second). So the trigger is disabled for exactly this statement, the events
 * are moved, and the merged chain is RE-LINKED in recorded order - hashes
 * change, and the script prints the last hash before and after. That is why a
 * duplicate carrying a sealed epoch is refused outright: its seal_hash names a
 * chain that would no longer exist.
 *
 * Two kinds of row cannot move and are dropped instead: a share or a tag for
 * an org that already has one on the canonical. Access rows, not history.
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../src/db";
import { custodyEpochs, instruments, orgInstrumentTags, systemEvents, systemShares } from "../src/db/schema";
import { hashOfEvent, GENESIS } from "../src/lib/custody/hash";
import { findGroups } from "./dedupe-instruments";

/** Every (table, column) that points at instruments.id and can move by UPDATE. */
const CHILD_COLUMNS: [string, string][] = [
  ["access_requests", "instrument_id"], ["assets", "instrument_id"], ["attachments", "instrument_id"],
  ["checkout_verdicts", "instrument_id"], ["custody_diffs", "instrument_id"], ["custody_events", "instrument_id"],
  ["device_leases", "instrument_id"], ["device_lockouts", "instrument_id"], ["discussion_posts", "instrument_id"],
  ["engagement_records", "instrument_id"], ["eod_updates", "instrument_id"], ["grants", "instrument_id"],
  ["instrument_gases", "instrument_id"], ["parts", "instrument_id"], ["pm_schedules", "instrument_id"],
  ["queue_events", "instrument_id"], ["remote_devices", "instrument_id"], ["restoration_projects", "instrument_id"],
  ["safety_holds", "instrument_id"], ["service_visits", "instrument_id"], ["signoffs", "instrument_id"],
  ["stage_events", "instrument_id"], ["stock_moves", "instrument_id"], ["tasks", "instrument_id"],
  ["time_entries", "instrument_id"], ["transfers", "instrument_id"], ["validation_docs", "instrument_id"],
  ["work_orders", "instrument_id"],
  // No FK on these two - they survive a system's deletion by design - but
  // they are the machine's history and they move with it.
  ["asset_events", "instrument_id"], ["audit_log", "instrument_id"],
];

export async function mergeGroup(canonicalId: number, apply: boolean): Promise<{ moved: Record<string, number>; dropped: number; relinked: number; before: string; after: string } | { error: string }> {
  const group = (await findGroups()).find((g) => g.canonicalId === canonicalId);
  if (!group) return { error: `no duplicate group is proposed around instrument ${canonicalId} - run the report` };
  if (group.blocked.length) return { error: `group is blocked:\n  ${group.blocked.join("\n  ")}` };
  const dups = group.ids.filter((id) => id !== canonicalId);
  const [canon] = await db.select().from(instruments).where(eq(instruments.id, canonicalId));
  if (!canon) return { error: "canonical row is gone" };

  const moved: Record<string, number> = {};
  let dropped = 0;

  // Access rows first, so the plain re-point below never trips their uniques.
  for (const id of dups) {
    const theirs = await db.select().from(systemShares).where(eq(systemShares.instrumentId, id));
    for (const s of theirs) {
      const [clash] = await db.select({ id: systemShares.id }).from(systemShares)
        .where(and(eq(systemShares.instrumentId, canonicalId), eq(systemShares.orgId, s.orgId)));
      if (clash) { dropped++; if (apply) await db.delete(systemShares).where(eq(systemShares.id, s.id)); }
      else { moved.system_shares = (moved.system_shares ?? 0) + 1; if (apply) await db.update(systemShares).set({ instrumentId: canonicalId }).where(eq(systemShares.id, s.id)); }
    }
    const tags = await db.select().from(orgInstrumentTags).where(eq(orgInstrumentTags.instrumentId, id));
    for (const t of tags) {
      const [clash] = await db.select({ id: orgInstrumentTags.id }).from(orgInstrumentTags)
        .where(and(eq(orgInstrumentTags.instrumentId, canonicalId), eq(orgInstrumentTags.orgId, t.orgId)));
      if (clash) { dropped++; if (apply) await db.delete(orgInstrumentTags).where(eq(orgInstrumentTags.id, t.id)); }
      else { moved.org_instrument_tags = (moved.org_instrument_tags ?? 0) + 1; if (apply) await db.update(orgInstrumentTags).set({ instrumentId: canonicalId }).where(eq(orgInstrumentTags.id, t.id)); }
    }
  }

  for (const [table, column] of CHILD_COLUMNS) {
    const [{ n }] = await db.execute<{ n: number }>(sql.raw(
      `SELECT count(*)::int AS n FROM "${table}" WHERE "${column}" IN (${dups.join(",")})`,
    )).then((r) => (r as unknown as { rows: { n: number }[] }).rows ?? (r as unknown as { n: number }[]));
    if (!n) continue;
    moved[table] = n;
    if (apply) {
      await db.execute(sql.raw(`UPDATE "${table}" SET "${column}" = ${canonicalId} WHERE "${column}" IN (${dups.join(",")})`));
    }
  }

  // Epochs: the report guarantees the duplicates have none that matter, but
  // an open one on a duplicate with the same holder as the canonical is the
  // materialize case and folds cleanly - it was never a separate tenure.
  const dupEpochs = await db.select().from(custodyEpochs).where(inArray(custodyEpochs.instrumentId, dups));
  if (dupEpochs.length) return { error: "duplicates carry epochs; the report should have blocked this" };

  // The chain. Disable the trigger for exactly the statements that move and
  // re-link, and re-enable it whatever happens.
  const events = await db.select().from(systemEvents)
    .where(inArray(systemEvents.instrumentId, [canonicalId, ...dups]))
    .orderBy(asc(systemEvents.recordedAt), asc(systemEvents.id));
  const beforeTail = [...events].filter((e) => e.instrumentId === canonicalId).pop()?.hash ?? GENESIS;
  let relinked = 0, afterTail = beforeTail;
  if (events.some((e) => e.instrumentId !== canonicalId)) {
    relinked = events.length;
    if (apply) {
      await db.execute(sql.raw(`ALTER TABLE "system_events" DISABLE TRIGGER "system_events_no_mutation"`));
      try {
        // Park every prev_hash on a unique placeholder first, or the re-link
        // collides with itself halfway through.
        for (const e of events) {
          await db.execute(sql.raw(`UPDATE "system_events" SET "instrument_id" = ${canonicalId}, "prev_hash" = 'relink:${e.id}' WHERE "id" = ${e.id}`));
        }
        let prev = GENESIS;
        for (const e of events) {
          const hash = hashOfEvent(prev, {
            kind: e.kind, occurredAt: e.occurredAt, authorOrgId: e.authorOrgId,
            procedureKeys: e.procedureKeys as never[], provenance: e.provenance as Record<string, unknown>,
          });
          await db.execute(sql`UPDATE "system_events" SET "prev_hash" = ${prev}, "hash" = ${hash} WHERE "id" = ${e.id}`);
          prev = hash;
        }
        afterTail = prev;
      } finally {
        await db.execute(sql.raw(`ALTER TABLE "system_events" ENABLE TRIGGER "system_events_no_mutation"`));
      }
    }
  }

  // The duplicates: archived, labelled, and their tag kept for the org that used it.
  for (const id of dups) {
    const [d] = await db.select().from(instruments).where(eq(instruments.id, id));
    if (!d) continue;
    if (apply) {
      await db.update(instruments).set({
        archived: true,
        notes: [d.notes, `Folded into ${canon.externalId} (#${canonicalId}) by merge-instruments - this row is a duplicate of the same machine.`].filter(Boolean).join("\n"),
      }).where(eq(instruments.id, id));
      const tagOrg = d.ownerOrgId ?? d.tenantOrgId;
      if (tagOrg !== null) {
        await db.insert(orgInstrumentTags).values({ orgId: tagOrg, instrumentId: canonicalId, externalId: d.externalId, createdBy: "merge-instruments" })
          .onConflictDoNothing();
      }
    }
  }
  return { moved, dropped, relinked, before: beforeTail, after: afterTail };
}

export async function main() {
  const apply = process.argv.includes("--apply");
  const at = process.argv.indexOf("--group");
  const canonicalId = at === -1 ? NaN : Number(process.argv[at + 1]);
  if (!Number.isInteger(canonicalId)) { console.error("[merge] --group <canonicalId> is required; see scripts/dedupe-instruments.ts"); process.exit(1); }
  const res = await mergeGroup(canonicalId, apply);
  if ("error" in res) { console.error(`[merge] refused: ${res.error}`); process.exit(1); }
  console.log(`[merge] ${apply ? "folded" : "would fold"} into #${canonicalId}:`);
  for (const [t, n] of Object.entries(res.moved)) console.log(`  ${t}: ${n} row(s)`);
  if (res.dropped) console.log(`  dropped ${res.dropped} redundant share/tag row(s) the canonical already had`);
  if (res.relinked) console.log(`  re-linked ${res.relinked} chain event(s): tail ${res.before.slice(0, 12) || "(genesis)"} -> ${apply ? res.after.slice(0, 12) : "(computed on apply)"}`);
  console.log(apply
    ? "[merge] done. Run scripts/backfill-epochs.ts --apply to place the moved events, then scripts/custody-parity.ts."
    : "[merge] dry run; pass --apply to write");
}

if (!process.env.VITEST) main().catch((e) => { console.error("[merge] failed:", e); process.exit(1); });
