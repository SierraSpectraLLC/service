// Server-side composition of the daily client report - the same template the
// EOD page previews (MM/DD/YY - Daily Updates, separators, renumbered around
// skipped entries), with each heading linking back to its portal page so
// replies migrate into discussions instead of reply-all email.
//
// One report per client: the systems a client OWNS, plus updates written on
// their assets. A client never sees another client's work in their report.
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import { db } from "@/db";
import { instruments, eodUpdates, assets, orgs } from "@/db/schema";
import { namedLogins } from "@/lib/directory";
import { getSystemLabels } from "@/lib/systemLabel";
import { brandForTenant, getBrand } from "@/lib/brand";
import { appUrl } from "@/lib/appUrl";
import { EMAIL, emailShell, esc } from "@/lib/emailTheme";

const SEP = "-".repeat(50);


/**
 * One line on the report: a system, a single asset, or work that happened off
 * the board entirely (see eod_updates.title).
 */
export type EodEntry = {
  kind: "system" | "asset" | "offsystem";
  /** The row's own id for an offsystem line - there is no record behind it. */
  id: number;
  externalId: string;
  label: string;
  systemUpdate: string;
  actionItem: string;
  skipped: boolean;
  /**
   * Written for our own bench, not for the client. Staff still see it on the
   * EOD page (that is where it gets marked); the client's report never
   * carries it. See eod_updates.internal.
   */
  internal: boolean;
  /** Something was written today - drives autopopulation on the EOD page. */
  written: boolean;
  /** offsystem only: who did it, and how long it took. */
  person?: string;
  minutes?: number;
};

/**
 * Does this system belong on `orgId`'s report for the date? The whole
 * live-versus-history distinction lives here, because getting it wrong loses
 * records silently: a system that has since shipped, been archived, or been
 * handed to a client lead has left the ACTIVE set, but its recorded update is
 * still history and must keep showing. Pure, so it is unit-tested.
 *
 * `recordedIds` is what THIS org recorded on this date, taken from the stamp on
 * the saved row rather than from who owns the system now. That distinction is
 * the difference between a report and a rewrite: a system sold last week must
 * not drag last month's updates onto the buyer's reports, nor off the seller's.
 * Today's list still reads current ownership, because a system nobody has
 * written about yet has no stamp to read.
 */
export function includesSystem(
  i: { id: number; ownerOrgId: number | null; archived: boolean; stages: string[]; lead: string },
  orgId: number | null,
  historical: boolean,
  recordedIds: Set<number>,
  clientLed: Set<string>,
): boolean {
  // History is driven by what was written, never by today's activity filters -
  // and never by today's owner.
  if (historical) return recordedIds.has(i.id);
  if ((i.ownerOrgId ?? null) !== orgId) return false;
  return !i.archived && !i.stages.includes("Shipped") && !clientLed.has(i.lead);
}

/**
 * A row that exists but says nothing - somebody clicked into the box and back
 * out - is not a record of anything, and must not make the day look reported.
 * A skipped line is different: leaving it out was the decision.
 */
const recordsSomething = (s: { systemUpdate: string; actionItem: string; skipped: boolean; title?: string }) =>
  !!(s.systemUpdate.trim() || s.actionItem.trim() || s.skipped || (s.title ?? "").trim());

/**
 * Is this saved row work logged off the board? Nothing to hang it on, and a
 * title saying what it was. Both halves matter: a row with no target and no
 * title is the debris of a half-finished write, not a record of anything.
 */
export const isOffSystem = (s: { instrumentId: number | null; assetId: number | null; title: string }) =>
  s.instrumentId === null && s.assetId === null && !!s.title.trim();

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
  const [rows, saved, directory, orgRow] = await Promise.all([
    // All systems: includesSystem decides, so an archived-but-recorded one is
    // still reachable in history.
    db.select().from(instruments).orderBy(asc(instruments.priority), asc(instruments.externalId)),
    db.select().from(eodUpdates).where(eq(eodUpdates.date, date)),
    namedLogins(),
    orgId === null ? Promise.resolve(undefined) : db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, orgId)).then((r) => r[0]),
  ]);

  // Systems led by one of the client's own people are theirs to report on, not
  // the operator's - a live-report rule only, never applied to history.
  const clientLed = new Set(directory.filter((p) => orgRow?.name && p.org === orgRow.name).map((p) => p.name));
  // What this org recorded that day, per the stamp on the row.
  const recorded = new Set(saved
    .filter((s) => s.instrumentId !== null && (s.ownerOrgId ?? null) === orgId && recordsSomething(s))
    .map((s) => s.instrumentId as number));
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
      internal: u?.internal ?? false,
      written: !!(u?.systemUpdate || u?.actionItem),
    };
  });

  // Asset-level updates: a unit this org owns, written on its own page. Live,
  // only shelf units get their own line (one on a system is covered by that
  // system's); in history every recorded line stands, wherever the unit sits
  // now.
  const assetUpdates = saved.filter((s) => s.assetId !== null
    && (historical ? (s.ownerOrgId ?? null) === orgId && recordsSomething(s) : true));
  if (assetUpdates.length) {
    const ids = assetUpdates.map((s) => s.assetId!) as number[];
    const owned = (await db.select().from(assets).where(inArray(assets.id, ids)))
      // History trusts the stamp already applied above; today reads live ownership.
      .filter((a) => (historical || ((a.ownerOrgId ?? null) === orgId && a.instrumentId === null)));
    for (const a of owned) {
      const u = assetUpdates.find((s) => s.assetId === a.id)!;
      entries.push({
        kind: "asset", id: a.id,
        externalId: a.serial ? `SN ${a.serial}` : a.kind,
        label: `${a.kind}${a.model ? ` - ${a.model}` : ""}${a.serial ? ` (SN ${a.serial})` : ""}`,
        systemUpdate: u.systemUpdate, actionItem: u.actionItem, skipped: u.skipped,
        internal: u.internal,
        written: !!(u.systemUpdate || u.actionItem),
      });
    }
  }

  // Work with nothing to hang it on, newest last so the day reads in order.
  // Same ownership stamp as everything else: the line belongs to the client it
  // was written for, today and in every later reading of this date.
  for (const u of saved.filter((s) => isOffSystem(s) && (s.ownerOrgId ?? null) === orgId)) {
    entries.push({
      kind: "offsystem", id: u.id,
      externalId: u.title.trim(),
      label: u.title.trim(),
      systemUpdate: u.systemUpdate, actionItem: u.actionItem, skipped: u.skipped,
      internal: u.internal,
      written: true,
      person: u.person, minutes: u.minutes,
    });
  }
  return entries;
}

/**
 * Which client groups a date has. Today: every org that owns active work, so
 * nothing waiting to be written is missed. A past day: every org a saved row is
 * STAMPED to - so a client with no active systems left still shows the history
 * they have, and a system that has since changed hands stays on the report of
 * the client it was written for.
 */
export async function eodGroups(
  date: string, historical = false,
  // Whose report this is. One workspace's clients and one workspace's systems -
  // null only on an instance with a single operator, where there is nothing to
  // separate.
  tenantOrgId: number | null = null,
): Promise<{ orgId: number | null; name: string; recipients: string }[]> {
  const mine = <T extends { tenantOrgId: number | null }>(rows: T[]) =>
    tenantOrgId === null ? rows : rows.filter((r) => r.tenantOrgId === tenantOrgId);
  const [rowsAll, orgRowsAll, brand, standaloneAll, savedAll] = await Promise.all([
    db.select({ id: instruments.id, ownerOrgId: instruments.ownerOrgId, archived: instruments.archived, tenantOrgId: instruments.tenantOrgId }).from(instruments),
    db.select().from(orgs).orderBy(asc(orgs.name)),
    getBrand(),
    historical ? Promise.resolve([]) : db.select({ id: assets.id, ownerOrgId: assets.ownerOrgId, tenantOrgId: assets.tenantOrgId }).from(assets)
      .where(and(
        isNull(assets.instrumentId),
        // A retired unit on tonight's client report is noise.
        ne(assets.status, "Decommissioned"),
      )),
    // Always, not just for history: an off-system line may be the ONLY thing a
    // client has today, and reading it off active equipment would miss it.
    db.select().from(eodUpdates).where(eq(eodUpdates.date, date)),
  ]);
  // Only this workspace's equipment, and only organizations it runs.
  const rows = mine(rowsAll);
  const standalone = mine(standaloneAll as { id: number; ownerOrgId: number | null; tenantOrgId: number | null }[]);
  const saved = mine(savedAll);
  const orgRows = tenantOrgId === null
    ? orgRowsAll
    : orgRowsAll.filter((o) => o.id === tenantOrgId || o.parentOrgId === tenantOrgId);
  // Off-system work has no equipment to be found through, so whichever way the
  // day is being read, the orgs it was logged against have to come off the rows.
  const offSystemOwners = saved.filter(isOffSystem).map((s) => s.ownerOrgId ?? null);
  const owners = historical
    // Straight off the rows: no join to who owns the equipment now, which is
    // what used to let a handoff move a past day's report between clients.
    ? new Set<number | null>(saved.filter(recordsSomething).map((s) => s.ownerOrgId ?? null))
    : new Set<number | null>([
        ...rows.filter((r) => !r.archived).map((r) => r.ownerOrgId ?? null),
        ...standalone.map((r) => r.ownerOrgId ?? null),
        ...offSystemOwners,
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

export async function composeEodEmail(
  date: string, dateMDY: string, orgId: number | null,
  // The workspace whose report this is: its name goes on the subject line, since
  // it is the company reporting the day's work.
  tenantOrgId: number | null = null,
): Promise<{
  subject: string; html: string; filled: number; total: number;
}> {
  const brand = await brandForTenant(tenantOrgId);
  const entries = await collectEodEntries(date, orgId, false);
  // Skipped is "not today"; internal is "not for them". Both leave the client's
  // report, and only the internal one stays on our own screen.
  const included = entries.filter((e) => !e.skipped && !e.internal);
  const url = appUrl();

  let filled = 0;
  const blocks = included.map((e, idx) => {
    if (e.written) filled++;
    const label = esc(e.label);
    // Off-system work has no page to link to - that is what makes it
    // off-system - so its heading is plain text and carries who did it
    // instead. "System Update" is the wrong words for a phone call.
    if (e.kind === "offsystem") {
      const by = [e.person ?? "", e.minutes ? `${e.minutes} min` : ""].filter(Boolean).map(esc).join(" · ");
      return `Support ${idx + 1}: ${label}${by ? ` (${by})` : ""}`
        + `\n\nWhat happened: ${esc(e.systemUpdate)}\nAction Item: ${esc(e.actionItem)}\n\n${SEP}`;
    }
    const href = e.kind === "system" ? `${url}/instruments/${e.id}` : `${url}/assets/${e.id}`;
    const noun = e.kind === "system" ? "System" : "Unit";
    const heading = url
      ? `<a href="${href}" style="color:${EMAIL.link};">${noun} ${idx + 1}: ${label}</a>`
      : `${noun} ${idx + 1}: ${label}`;
    return `${heading}\n\nSystem Update: ${esc(e.systemUpdate)}\nAction Item: ${esc(e.actionItem)}\n\n${SEP}`;
  });

  const body = [`${dateMDY} - Daily Updates`, "", SEP, ...blocks].join("\n");
  const html = emailShell({
    brand: brand.operatorName,
    logoUrl: brand.operatorLogoUrl || undefined,
    tagline: `Daily Updates · ${dateMDY}`,
    preheader: `${included.length} line${included.length === 1 ? "" : "s"} on today's report.`,
    width: 640,
    body: `<pre style="font-family:${EMAIL.mono};font-size:13px;line-height:1.5;white-space:pre-wrap;color:${EMAIL.ink};margin:0;">${body}</pre>`,
    footer: url
      ? `Questions on a system? Tap its heading and reply in the portal - it keeps everyone on the same page. General topics: <a href="${url}/discussions" style="color:${EMAIL.faint};">${esc(url.replace(/^https?:\/\//, ""))}/discussions</a>`
      : `Sent by ${esc(brand.operatorName)}.`,
  });

  return { subject: `${brand.operatorName} - Daily Updates ${dateMDY}`, html, filled, total: included.length };
}
