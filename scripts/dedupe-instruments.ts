/**
 * Two rows, one machine: the report.
 *   DATABASE_URL=... npx tsx scripts/dedupe-instruments.ts
 *
 * REPORT ONLY. Nothing is written. Every group it prints is a decision for a
 * person: which row is the machine, and whether the others can be folded into
 * it by scripts/merge-instruments. A script that picked the canonical row on
 * its own would be choosing whose history a machine keeps, at 3am.
 *
 * A group is two or more instrument rows that share (lower(manufacturer),
 * lower(serial)) with both non-blank, or that are linked by source_ref - the
 * tag lib/clientShare wrote on a copy, pointing at the sender's tag. The
 * proposed canonical is the OLDEST row that is not itself a copy; a group
 * whose non-canonical rows carry a sealed or claimed epoch is BLOCKED, because
 * folding a sealed tenure into another row would rewrite a record somebody
 * already received.
 */
import { inArray } from "drizzle-orm";
import { db } from "../src/db";
import { custodyEpochs, instruments, orgs } from "../src/db/schema";

export type DupGroup = {
  key: string;
  canonicalId: number;
  ids: number[];
  blocked: string[];
};

export async function findGroups(): Promise<DupGroup[]> {
  const rows = await db.select({
    id: instruments.id, externalId: instruments.externalId, sourceRef: instruments.sourceRef,
    manufacturer: instruments.manufacturer, serial: instruments.serial, tenantOrgId: instruments.tenantOrgId,
    createdAt: instruments.createdAt, archived: instruments.archived,
  }).from(instruments);

  // Union-find over two link kinds: shared serial, and source_ref -> external_id.
  const parent = new Map<number, number>();
  const find = (x: number): number => { const p = parent.get(x) ?? x; if (p === x) return x; const r = find(p); parent.set(x, r); return r; };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  const bySerial = new Map<string, number[]>();
  for (const r of rows) {
    const m = r.manufacturer.trim().toLowerCase(), s = r.serial.trim().toLowerCase();
    if (!m || !s) continue;
    const k = `${m}|${s}`;
    bySerial.set(k, [...(bySerial.get(k) ?? []), r.id]);
  }
  for (const ids of bySerial.values()) for (const id of ids.slice(1)) union(ids[0], id);
  const byTag = new Map(rows.map((r) => [r.externalId, r.id]));
  for (const r of rows) {
    if (!r.sourceRef) continue;
    const src = byTag.get(r.sourceRef);
    if (src !== undefined && src !== r.id) union(r.id, src);
  }

  const groups = new Map<number, typeof rows>();
  for (const r of rows) {
    const root = find(r.id);
    if (root === r.id && !rows.some((o) => o.id !== r.id && find(o.id) === r.id)) continue;
    groups.set(root, [...(groups.get(root) ?? []), r]);
  }

  const out: DupGroup[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const ids = members.map((m) => m.id);
    const originals = members.filter((m) => !m.sourceRef);
    const canonical = [...(originals.length ? originals : members)]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id)[0];
    const others = ids.filter((id) => id !== canonical.id);
    const epochs = await db.select({ instrumentId: custodyEpochs.instrumentId, closeKind: custodyEpochs.closeKind, n: custodyEpochs.n })
      .from(custodyEpochs).where(inArray(custodyEpochs.instrumentId, others));
    const blocked = epochs
      .filter((e) => e.closeKind !== "open")
      .map((e) => `row ${e.instrumentId} has a ${e.closeKind} epoch (n=${e.n}) - a received record cannot be folded`);
    const openOnOthers = epochs.filter((e) => e.closeKind === "open");
    if (openOnOthers.length) blocked.push(`row(s) ${openOnOthers.map((e) => e.instrumentId).join(", ")} hold an open epoch - close or resume by hand first`);
    out.push({
      key: members.map((m) => m.externalId).sort().join(" = "),
      canonicalId: canonical.id, ids, blocked,
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

export async function main() {
  const groups = await findGroups();
  const tenantName = new Map((await db.select({ id: orgs.id, name: orgs.name }).from(orgs)).map((o) => [o.id, o.name]));
  const byId = new Map((await db.select({ id: instruments.id, externalId: instruments.externalId, tenantOrgId: instruments.tenantOrgId, sourceRef: instruments.sourceRef, serial: instruments.serial })
    .from(instruments)).map((i) => [i.id, i]));

  console.log(`[dedupe] ${groups.length} group(s) of rows that look like one machine`);
  for (const g of groups) {
    console.log(`\n  ${g.key}${g.blocked.length ? "   BLOCKED" : ""}`);
    for (const id of g.ids) {
      const i = byId.get(id)!;
      console.log(`    ${id === g.canonicalId ? "*" : " "} #${id} ${i.externalId} (${tenantName.get(i.tenantOrgId ?? -1) ?? "no tenant"})`
        + `${i.serial ? ` SN ${i.serial}` : ""}${i.sourceRef ? ` copy of ${i.sourceRef}` : ""}`);
    }
    for (const b of g.blocked) console.log(`      ! ${b}`);
  }
  if (groups.length) {
    console.log("\n[dedupe] * = proposed canonical row. Review, then: npx tsx scripts/merge-instruments.ts --group <canonicalId> --apply");
  } else {
    console.log("[dedupe] nothing to fold - one row per machine already");
  }
}

if (!process.env.VITEST) main().catch((e) => { console.error("[dedupe] failed:", e); process.exit(1); });
