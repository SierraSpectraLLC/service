// Server-side composition of the daily client report - the same template the
// EOD page previews (MM/DD/YY - Daily Updates, separators, renumbered around
// skipped entries), with each heading linking back to its portal page so
// replies migrate into discussions instead of reply-all email.
//
// One report per client: the systems a client OWNS, plus updates written on
// their assets. A client never sees another client's work in their report.
import { asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { instruments, eodUpdates, people, assets, orgs } from "@/db/schema";
import { getSystemLabels } from "@/lib/systemLabel";
import { getBrand } from "@/lib/brand";

const SEP = "-".repeat(50);
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const appUrl = () =>
  process.env.APP_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "");

/** One line on the report: a system or a single asset, with the day's update. */
export type EodEntry = {
  kind: "system" | "asset";
  id: number;
  externalId: string;
  label: string;
  systemUpdate: string;
  actionItem: string;
  skipped: boolean;
  /** Something was written today - drives autopopulation on the EOD page. */
  written: boolean;
};

/**
 * Everything that belongs on one client's report for a date, in report order:
 * their active systems, then updates written on their assets. `orgId` null
 * means the operator's own group - systems nobody else owns.
 */
export async function collectEodEntries(date: string, orgId: number | null): Promise<EodEntry[]> {
  const [rows, saved, roster, orgRow] = await Promise.all([
    db.select().from(instruments).where(eq(instruments.archived, false))
      .orderBy(asc(instruments.priority), asc(instruments.externalId)),
    db.select().from(eodUpdates).where(eq(eodUpdates.date, date)),
    db.select().from(people),
    orgId === null ? Promise.resolve(undefined) : db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, orgId)).then((r) => r[0]),
  ]);

  // Systems led by one of the client's own people are theirs to report on, not
  // the operator's.
  const clientLed = new Set(roster.filter((p) => orgRow?.name && p.org === orgRow.name).map((p) => p.name));
  const mine = rows.filter((i) =>
    (i.ownerOrgId ?? null) === orgId && !i.stages.includes("Shipped") && !clientLed.has(i.lead));

  const labels = await getSystemLabels(mine);
  const entries: EodEntry[] = mine.map((i) => {
    const u = saved.find((s) => s.instrumentId === i.id);
    const named = labels.get(i.id) ?? "";
    return {
      kind: "system", id: i.id, externalId: i.externalId,
      label: named ? `${i.externalId} - ${named}` : i.externalId,
      systemUpdate: u?.systemUpdate ?? "", actionItem: u?.actionItem ?? "",
      skipped: u?.skipped ?? false,
      written: !!(u?.systemUpdate || u?.actionItem),
    };
  });

  // Asset-level updates: a standalone unit this org owns, written on its own
  // page. Assets sitting on a system are covered by that system's line.
  const assetUpdates = saved.filter((s) => s.assetId !== null);
  if (assetUpdates.length) {
    const ids = assetUpdates.map((s) => s.assetId!) as number[];
    const owned = (await db.select().from(assets).where(inArray(assets.id, ids)))
      .filter((a) => (a.ownerOrgId ?? null) === orgId && a.instrumentId === null);
    for (const a of owned) {
      const u = assetUpdates.find((s) => s.assetId === a.id)!;
      entries.push({
        kind: "asset", id: a.id,
        externalId: a.serial ? `SN ${a.serial}` : a.kind,
        label: `${a.kind}${a.model ? ` — ${a.model}` : ""}${a.serial ? ` (SN ${a.serial})` : ""}`,
        systemUpdate: u.systemUpdate, actionItem: u.actionItem, skipped: u.skipped,
        written: !!(u.systemUpdate || u.actionItem),
      });
    }
  }
  return entries;
}

/** Which client groups exist for a date: every org that owns active work, plus the operator's own. */
export async function eodGroups(): Promise<{ orgId: number | null; name: string; recipients: string }[]> {
  const [rows, orgRows, brand, standalone] = await Promise.all([
    db.select({ ownerOrgId: instruments.ownerOrgId }).from(instruments).where(eq(instruments.archived, false)),
    db.select().from(orgs).orderBy(asc(orgs.name)),
    getBrand(),
    db.select({ ownerOrgId: assets.ownerOrgId }).from(assets).where(isNull(assets.instrumentId)),
  ]);
  const owners = new Set<number | null>([
    ...rows.map((r) => r.ownerOrgId ?? null),
    ...standalone.map((r) => r.ownerOrgId ?? null),
  ]);
  const groups: { orgId: number | null; name: string; recipients: string }[] = [];
  // The operator's own group first: house-stewarded work, reported internally.
  if (owners.has(null)) {
    const op = orgRows.find((o) => o.id === brand.operatorOrgId);
    groups.push({ orgId: null, name: op ? `${op.name} (own work)` : `${brand.name} (own work)`, recipients: op?.eodRecipients ?? "" });
  }
  for (const o of orgRows) {
    if (owners.has(o.id)) groups.push({ orgId: o.id, name: o.name, recipients: o.eodRecipients });
  }
  return groups;
}

export async function composeEodEmail(date: string, dateMDY: string, orgId: number | null): Promise<{
  subject: string; html: string; filled: number; total: number;
}> {
  const brand = await getBrand();
  const entries = await collectEodEntries(date, orgId);
  const included = entries.filter((e) => !e.skipped);
  const url = appUrl();

  let filled = 0;
  const blocks = included.map((e, idx) => {
    if (e.written) filled++;
    const href = e.kind === "system" ? `${url}/instruments/${e.id}` : `${url}/assets/${e.id}`;
    const label = esc(e.label);
    const noun = e.kind === "system" ? "System" : "Unit";
    const heading = url
      ? `<a href="${href}" style="color:#1D6396;">${noun} ${idx + 1}: ${label}</a>`
      : `${noun} ${idx + 1}: ${label}`;
    return `${heading}\n\nSystem Update: ${esc(e.systemUpdate)}\nAction Item: ${esc(e.actionItem)}\n\n${SEP}`;
  });

  const body = [`${dateMDY} - Daily Updates`, "", SEP, ...blocks].join("\n");
  const html = `
    <pre style="font-family:Menlo,Consolas,monospace;font-size:13px;line-height:1.5;white-space:pre-wrap;color:#172A4A;margin:0;">${body}</pre>
    ${url ? `<div style="font-family:Helvetica,Arial,sans-serif;font-size:12px;color:#64748B;margin-top:16px;">Questions on a system? Tap its heading and reply in the portal - it keeps everyone on the same page. General topics: <a href="${url}/discussions">${url.replace(/^https?:\/\//, "")}/discussions</a></div>` : ""}`;

  return { subject: `${brand.operatorName} - Daily Updates ${dateMDY}`, html, filled, total: included.length };
}
