// Server-side composition of the daily client report - the same template the
// EOD page previews (MM/DD/YY - Daily Updates, separators, renumbered around
// skipped entries), with each heading linking back to its portal page so
// replies migrate into discussions instead of reply-all email.
//
// One report per client: the systems a client OWNS, plus updates written on
// their assets. A client never sees another client's work in their report.
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { instruments, eodUpdates, people, assets, orgs } from "@/db/schema";
import { getSystemLabels } from "@/lib/systemLabel";
import { getBrand } from "@/lib/brand";
import { appUrl } from "@/lib/appUrl";

const SEP = "-".repeat(50);
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");


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
 * Does this system belong on `orgId`'s report for the date? The whole
 * live-versus-history distinction lives here, because getting it wrong loses
 * records silently: a system that has since shipped, been archived, or been
 * handed to a client lead has left the ACTIVE set, but its recorded update is
 * still history and must keep showing. Pure, so it is unit-tested.
 */
export function includesSystem(
  i: { id: number; ownerOrgId: number | null; archived: boolean; stages: string[]; lead: string },
  orgId: number | null,
  historical: boolean,
  recordedIds: Set<number>,
  clientLed: Set<string>,
): boolean {
  if ((i.ownerOrgId ?? null) !== orgId) return false;
  // History is driven by what was written, never by today's activity filters.
  if (historical) return recordedIds.has(i.id);
  return !i.archived && !i.stages.includes("Shipped") && !clientLed.has(i.lead);
}

/**
 * Everything that belongs on one client's report for a date, in report order:
 * their systems, then updates written on their assets. `orgId` null means the
 * operator's own group - work nobody else owns.
 *
 * `historical` flips where the list comes from, and that distinction matters:
 * TODAY the page must offer every system still being worked, whether or not
 * anything is written yet. A PAST DAY must show what was actually recorded,
 * driven off the saved rows - a system since shipped, archived, reassigned or
 * handed to a client lead has left the active set, and reading history through
 * today's filters would silently erase its entry.
 */
export async function collectEodEntries(date: string, orgId: number | null, historical = false): Promise<EodEntry[]> {
  const [rows, saved, roster, orgRow] = await Promise.all([
    // All systems: includesSystem decides, so an archived-but-recorded one is
    // still reachable in history.
    db.select().from(instruments).orderBy(asc(instruments.priority), asc(instruments.externalId)),
    db.select().from(eodUpdates).where(eq(eodUpdates.date, date)),
    db.select().from(people),
    orgId === null ? Promise.resolve(undefined) : db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, orgId)).then((r) => r[0]),
  ]);

  // Systems led by one of the client's own people are theirs to report on, not
  // the operator's - a live-report rule only, never applied to history.
  const clientLed = new Set(roster.filter((p) => orgRow?.name && p.org === orgRow.name).map((p) => p.name));
  const recorded = new Set(saved.filter((s) => s.instrumentId !== null).map((s) => s.instrumentId as number));
  const mine = rows.filter((i) => includesSystem(i, orgId, historical, recorded, clientLed));

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

  // Asset-level updates: a unit this org owns, written on its own page. Live,
  // only shelf units get their own line (one on a system is covered by that
  // system's); in history every recorded line stands, wherever the unit sits
  // now.
  const assetUpdates = saved.filter((s) => s.assetId !== null);
  if (assetUpdates.length) {
    const ids = assetUpdates.map((s) => s.assetId!) as number[];
    const owned = (await db.select().from(assets).where(inArray(assets.id, ids)))
      .filter((a) => (a.ownerOrgId ?? null) === orgId && (historical || a.instrumentId === null));
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

/**
 * Which client groups a date has. Today: every org that owns active work, so
 * nothing waiting to be written is missed. A past day: every org that owns
 * something which recorded an update, so a client with no active systems left
 * still shows the history they have.
 */
export async function eodGroups(date: string, historical = false): Promise<{ orgId: number | null; name: string; recipients: string }[]> {
  const [rows, orgRows, brand, standalone, saved] = await Promise.all([
    db.select({ id: instruments.id, ownerOrgId: instruments.ownerOrgId, archived: instruments.archived }).from(instruments),
    db.select().from(orgs).orderBy(asc(orgs.name)),
    getBrand(),
    db.select({ id: assets.id, ownerOrgId: assets.ownerOrgId }).from(assets)
      .where(historical ? undefined : and(
        isNull(assets.instrumentId),
        // A retired unit on tonight's client report is noise.
        ne(assets.status, "Decommissioned"),
      )),
    historical ? db.select().from(eodUpdates).where(eq(eodUpdates.date, date)) : Promise.resolve([]),
  ]);
  const owners = historical
    ? new Set<number | null>([
        ...rows.filter((r) => saved.some((s) => s.instrumentId === r.id)).map((r) => r.ownerOrgId ?? null),
        ...standalone.filter((a) => saved.some((s) => s.assetId === a.id)).map((a) => a.ownerOrgId ?? null),
      ])
    : new Set<number | null>([
        ...rows.filter((r) => !r.archived).map((r) => r.ownerOrgId ?? null),
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
  const entries = await collectEodEntries(date, orgId, false);
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
