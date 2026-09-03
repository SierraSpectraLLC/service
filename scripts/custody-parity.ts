/**
 * Where the derived custodian and the stored pointer disagree.
 *   DATABASE_URL=... npx tsx scripts/custody-parity.ts [--apply]
 *
 * DOES NOT SWITCH THE POINTER, in either direction, ever. That is the whole
 * design: instruments.owner_org_id is what every existing surface believes, the
 * open epoch is what the handoff chain implies, and a script that silently
 * preferred one would reassign machines on a deploy with nobody looking. It
 * writes the differences to custody_diffs and stops - the same move sheet-sync
 * makes with sheet_diffs, for the same reason.
 *
 * A clean run prints zero and writes nothing. On a production branch, every row
 * it writes wants a written explanation before Phase 8 retires the pointer.
 */
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { custodyDiffs, custodyEpochs, instruments, orgs } from "../src/db/schema";

export async function main() {
  const apply = process.argv.includes("--apply");

  const insts = await db.select({
    id: instruments.id, externalId: instruments.externalId, ownerOrgId: instruments.ownerOrgId,
  }).from(instruments);
  const open = await db.select({
    instrumentId: custodyEpochs.instrumentId, custodianOrgId: custodyEpochs.custodianOrgId,
    custodianName: custodyEpochs.custodianName,
  }).from(custodyEpochs).where(eq(custodyEpochs.closeKind, "open"));
  const openOf = new Map(open.map((e) => [e.instrumentId, e]));
  const orgName = new Map((await db.select({ id: orgs.id, name: orgs.name }).from(orgs)).map((o) => [o.id, o.name]));
  const nameOf = (id: number | null) => id === null ? "house stewardship" : orgName.get(id) ?? `org ${id}`;

  type Diff = { instrumentId: number; externalId: string; storedOrgId: number | null; derivedOrgId: number | null; note: string };
  const diffs: Diff[] = [];
  let agreed = 0, untracked = 0;

  for (const inst of insts) {
    const epoch = openOf.get(inst.id);
    if (!epoch) {
      // No handoff has ever been recorded for this machine, so there is nothing
      // to disagree with. Not a diff: an absence of history is not a conflict.
      untracked++;
      continue;
    }
    if (epoch.custodianOrgId === inst.ownerOrgId) { agreed++; continue; }
    diffs.push({
      instrumentId: inst.id, externalId: inst.externalId,
      storedOrgId: inst.ownerOrgId, derivedOrgId: epoch.custodianOrgId,
      note: `owner_org_id says ${nameOf(inst.ownerOrgId)}; the open epoch says ${nameOf(epoch.custodianOrgId)}`,
    });
  }

  if (apply) {
    await db.delete(custodyDiffs);
    for (const d of diffs) {
      await db.insert(custodyDiffs).values({
        instrumentId: d.instrumentId, externalId: d.externalId,
        storedOrgId: d.storedOrgId, storedName: nameOf(d.storedOrgId),
        derivedOrgId: d.derivedOrgId, derivedName: nameOf(d.derivedOrgId),
        note: d.note,
      });
    }
  }

  console.log(`[parity] ${insts.length} machine(s): ${agreed} agree, ${diffs.length} differ, ${untracked} have no custody history`);
  for (const d of diffs) console.log(`  - ${d.externalId}: ${d.note}`);
  if (!diffs.length) console.log("[parity] clean - the pointer and the chain say the same thing everywhere");
  if (!apply && diffs.length) console.log("[parity] dry run; pass --apply to record these in custody_diffs");
}

// Auto-runs when you run it, and stays quiet when a test imports it to
// drive main() against a database of its own. A backfill nobody can
// exercise is a backfill nobody knows the behaviour of.
if (!process.env.VITEST) main().catch((e) => { console.error("[parity] failed:", e); process.exit(1); });
