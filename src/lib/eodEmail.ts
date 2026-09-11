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
import { forTenant } from "@/lib/tenancy";
import { getSystemLabels } from "@/lib/systemLabel";
import { brandForTenant, getBrand } from "@/lib/brand";
import { appUrl } from "@/lib/appUrl";
import { EMAIL, emailShell, esc } from "@/lib/emailTheme";
import { eodAuthorName, groupEodEntries, isOwnEodRow, nestEodGroups, type EodViewer } from "@/lib/eodLines";
import { membershipResolver } from "@/lib/moduleMembershipData";

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
  /**
   * WHOSE LINE. The saved row's id (null for a line nobody has written yet),
   * the author stamp, the name it is attributed to, and whether it is the
   * viewer's own - the one they type into. A system two people worked is two
   * entries here, one per person; see db/schema.eodUpdates.
   */
  eodId: number | null;
  author: string;
  by: string;
  mine: boolean;
  /**
   * For a unit: the system it was in on this date, when that system is on
   * this report. Its lines then sit under the system's entry rather than as
   * an entry of their own - a detector's refurbishment reads under the mass
   * spec it was being refurbished in. Today reads current membership; a past
   * day reads the move log (lib/moduleMembership), so a unit since moved on
   * still reports under the system it was in THEN.
   */
  parent?: { id: number; externalId: string; label: string } | null;
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
/**
 * WHICH SYSTEMS AND UNITS A DAY'S REPORT IS MADE OF.
 *
 *   live     - today: what this client owns and we are working on now.
 *   history  - a past day, read only: exactly what was written, by the stamp
 *              on each row, so an archived or handed-on system still shows
 *              the line it had that day.
 *   backfill - a past day being WRITTEN. The union of the two, because a shop
 *              writing up Friday on Monday needs both the lines it already has
 *              and the ones it never got to.
 *
 * A boolean used to carry this, which was fine while a past day could only be
 * read. It cannot express the union, and the union is the whole of backdating.
 */
export type EodMode = "live" | "history" | "backfill";

export function includesSystem(
  i: { id: number; ownerOrgId: number | null; archived: boolean; stages: string[]; lead: string },
  orgId: number | null,
  mode: EodMode,
  recordedIds: Set<number>,
  clientLed: Set<string>,
): boolean {
  // History is driven by what was written, never by today's activity filters -
  // and never by today's owner.
  if (mode === "history") return recordedIds.has(i.id);
  const live = (i.ownerOrgId ?? null) === orgId
    && !i.archived && !i.stages.includes("Shipped") && !clientLed.has(i.lead);
  /* Backfill is the UNION, and it has to be. Recorded-only cannot take a line
     that was never written - which is the whole point of writing up a day
     afterwards - and live-only would drop what WAS written on a system since
     archived or handed on, quietly rewriting the day being corrected. */
  return mode === "backfill" ? live || recordedIds.has(i.id) : live;
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
export async function collectEodEntries(
  date: string, orgId: number | null, mode: EodMode = "live",
  /**
   * The workspace this report is for. Load-bearing on the HOUSE edition:
   * includesSystem keeps a system when `(i.ownerOrgId ?? null) === orgId`, and
   * on that edition orgId is null - which matches every unowned system in
   * EVERY workspace, not just this one's. Null here keeps the old unrestricted
   * behaviour for platform-level callers and pre-tenancy instances.
   */
  tenantOrgId: number | null = null,
  /**
   * Who is reading, when somebody is: their own line comes first on each
   * system and is marked `mine`, and a system they have not written on yet
   * gets a blank line of theirs to type into. Absent for a composed email,
   * which has no reader and needs no blanks.
   */
  viewer: EodViewer | null = null,
): Promise<EodEntry[]> {
  const [rows, saved, directory, orgRow] = await Promise.all([
    // This workspace's systems: includesSystem then decides, so an
    // archived-but-recorded one is still reachable in history.
    db.select().from(instruments)
      .where(forTenant(instruments.tenantOrgId, tenantOrgId))
      .orderBy(asc(instruments.priority), asc(instruments.externalId)),
    db.select().from(eodUpdates).where(and(
      eq(eodUpdates.date, date), forTenant(eodUpdates.tenantOrgId, tenantOrgId))),
    namedLogins(),
    orgId === null ? Promise.resolve(undefined) : db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, orgId)).then((r) => r[0]),
  ]);

  // Systems led by one of the client's own people are theirs to report on, not
  // the operator's - a live-report rule only, never applied to history.
  const clientLed = new Set(directory.filter((p) => orgRow?.name && p.org === orgRow.name).map((p) => p.name));
  // What this org recorded that day, per the stamp on the row.
  /*
   * UNITS, first, because they can put a system on the report. A unit's line
   * is written on the unit and filed under the system the unit was in on the
   * day (lib/moduleMembership.homeOn: today, where it sits; a past day, from
   * the move log). So a past day where only a system's detector was written
   * up still reads as that system - the unit row's stamp names the client,
   * and its home that day names the system.
   */
  const stamped = (s: typeof eodUpdates.$inferSelect) => (s.ownerOrgId ?? null) === orgId && recordsSomething(s);
  const unitRows = saved.filter((s) => s.assetId !== null);
  const written = unitRows.length
    ? await db.select().from(assets).where(inArray(assets.id, [...new Set(unitRows.map((s) => s.assetId as number))]))
    : [];
  const membership = mode === "live" ? null : await membershipResolver(written.map((a) => a.id));
  const homeOf = (a: typeof assets.$inferSelect): number | null =>
    membership ? membership.homeOn(a.id, date) : a.instrumentId;
  const recorded = new Set([
    ...saved.filter((s) => s.instrumentId !== null && stamped(s)).map((s) => s.instrumentId as number),
    ...written.filter((a) => unitRows.some((s) => s.assetId === a.id && stamped(s)))
      .map((a) => homeOf(a)).filter((x): x is number => x !== null),
  ]);
  const mine = rows.filter((i) => includesSystem(i, orgId, mode, recorded, clientLed));

  const labels = await getSystemLabels(mine);
  /*
   * One system, several people's lines. The viewer's own first - it is the one
   * they came to write - then everybody else's in the order they were written.
   * With no line of their own yet, the viewer gets a blank one to type into;
   * without a viewer at all, a system nobody wrote on is one blank entry, as
   * it always was, so the report's count of "lines" still has a denominator.
   */
  const linesFor = (
    saved: (typeof eodUpdates.$inferSelect)[],
    blank: Omit<EodEntry, "systemUpdate" | "actionItem" | "skipped" | "internal" | "written" | "eodId" | "author" | "by" | "mine">,
  ): EodEntry[] => {
    const own = saved.filter((s) => isOwnEodRow(s, viewer));
    const theirs = saved.filter((s) => !isOwnEodRow(s, viewer))
      .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
    const shape = (u: typeof eodUpdates.$inferSelect, isMine: boolean): EodEntry => ({
      ...blank,
      systemUpdate: u.systemUpdate, actionItem: u.actionItem,
      skipped: u.skipped, internal: u.internal,
      written: !!(u.systemUpdate || u.actionItem),
      eodId: u.id, author: u.author, by: eodAuthorName(u), mine: isMine,
    });
    const out = [...own.map((u) => shape(u, true)), ...theirs.map((u) => shape(u, false))];
    if (viewer && !own.length) {
      out.unshift({
        ...blank, systemUpdate: "", actionItem: "", skipped: false, internal: false, written: false,
        eodId: null, author: viewer.email.trim().toLowerCase(), by: viewer.name, mine: true,
      });
    } else if (!viewer && !out.length) {
      out.push({
        ...blank, systemUpdate: "", actionItem: "", skipped: false, internal: false, written: false,
        eodId: null, author: "", by: "", mine: false,
      });
    }
    return out;
  };

  const systemLabel = (i: { externalId: string; id: number }) => {
    const named = labels.get(i.id) ?? "";
    return named ? `${i.externalId} - ${named}` : i.externalId;
  };
  const systemEntries = new Map(mine.map((i) => [i.id, linesFor(saved.filter((s) => s.instrumentId === i.id), {
    kind: "system", id: i.id, externalId: i.externalId, label: systemLabel(i),
  })]));

  /*
   * WHICH UNIT LINES ARE THIS CLIENT'S: the home decides. A unit's line for
   * a day belongs to the report of the system it was in that day, whoever
   * owns the unit - the work was done in that system, and that is what the
   * client is being told about. (upsertEodLine stamps the row that way at
   * write time too.) A unit in no system that day is the shelf, and a shelf
   * unit is the client's when they own it (today) or the row is stamped to
   * them (a past day, either).
   *
   * That is one rule for all three modes. It used to be three: today took
   * every row on a unit in the client's system, a past day wanted the unit's
   * own owner, and the two disagreed about which lines a client had been
   * sent - and a past day took every unit row in the workspace onto every
   * client's panel.
   *
   * WHAT IS OFFERED TO WRITE. On today's page each unit in a client's system
   * gets a blank line of the viewer's own, so a module can be written up from
   * the EOD page without opening the unit. A shelf unit is written on its own.
   */
  const systemIds = [...systemEntries.keys()];
  const installed = mode === "live" && viewer && systemIds.length
    ? await db.select().from(assets).where(and(inArray(assets.instrumentId, systemIds), ne(assets.status, "Decommissioned")))
    : [];
  const units = new Map<number, typeof assets.$inferSelect>();
  for (const a of [...written, ...installed]) units.set(a.id, a);
  const ownedLive = (a: typeof assets.$inferSelect) => (a.ownerOrgId ?? null) === orgId;
  const rowsOf = (a: typeof assets.$inferSelect) =>
    unitRows.filter((s) => s.assetId === a.id && (mode === "live" || recordsSomething(s)));
  const unitEntry = (a: typeof assets.$inferSelect, home: { id: number; externalId: string } | null) => ({
    kind: "asset" as const, id: a.id,
    externalId: a.serial ? `SN ${a.serial}` : a.kind,
    label: `${a.kind}${a.model ? ` - ${a.model}` : ""}${a.serial ? ` (SN ${a.serial})` : ""}`,
    parent: home ? { id: home.id, externalId: home.externalId, label: systemLabel(home) } : null,
  });
  const unitOrder = (a: typeof assets.$inferSelect, b: typeof assets.$inferSelect) =>
    (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.id - b.id;

  const entries: EodEntry[] = [];
  for (const i of mine) {
    entries.push(...systemEntries.get(i.id)!);
    for (const a of [...units.values()].filter((x) => homeOf(x) === i.id).sort(unitOrder)) {
      const rows = rowsOf(a);
      if (!rows.length && !(mode === "live" && viewer)) continue;
      const lines = linesFor(rows, unitEntry(a, i));
      entries.push(...(mode === "live" && viewer ? lines : lines.filter((e) => e.eodId !== null)));
    }
  }
  // The shelf: units in no system that day. Written lines only.
  for (const a of [...units.values()].filter((x) => homeOf(x) === null).sort(unitOrder)) {
    const rows = rowsOf(a);
    const theirs = mode === "live" ? ownedLive(a) : rows.some(stamped) || (mode === "backfill" && ownedLive(a));
    if (!rows.length || !theirs) continue;
    entries.push(...linesFor(rows, unitEntry(a, null)).filter((e) => e.eodId !== null));
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
      eodId: u.id, author: u.author, by: eodAuthorName(u), mine: isOwnEodRow(u, viewer),
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
  date: string, mode: EodMode = "live",
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
    mode === "history" ? Promise.resolve([]) : db.select({ id: assets.id, ownerOrgId: assets.ownerOrgId, tenantOrgId: assets.tenantOrgId }).from(assets)
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
  const owners = mode === "history"
    // Straight off the rows: no join to who owns the equipment now, which is
    // what used to let a handoff move a past day's report between clients.
    ? new Set<number | null>(saved.filter(recordsSomething).map((s) => s.ownerOrgId ?? null))
    : new Set<number | null>([
        ...rows.filter((r) => !r.archived).map((r) => r.ownerOrgId ?? null),
        ...standalone.map((r) => r.ownerOrgId ?? null),
        ...offSystemOwners,
        /* Backfill keeps whoever the day was written for as well, so a client
           whose only system has since been archived is still a group somebody
           can correct. */
        ...(mode === "backfill"
          ? saved.filter(recordsSomething).map((s) => s.ownerOrgId ?? null) : []),
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
  /* The preview on a past day has to be composed the same way that day is
     being SHOWN, or the mail underneath the page disagrees with the page. */
  mode: EodMode = "live",
): Promise<{
  subject: string; html: string; filled: number; total: number;
}> {
  const brand = await brandForTenant(tenantOrgId);
  const entries = await collectEodEntries(date, orgId, mode, tenantOrgId);
  // Skipped is "not today"; internal is "not for them". Both leave the client's
  // report, and only the internal one stays on our own screen.
  const included = entries.filter((e) => !e.skipped && !e.internal);
  const url = appUrl();

  let filled = 0;
  /*
   * Numbered by what each line is ABOUT, not by line: a system two people
   * wrote about is "System 3" once, with each person's update under it and
   * their name on it. One person's line keeps the shape the report has always
   * had, so a day nobody shared reads exactly as before.
   */
  const blocks = nestEodGroups(groupEodEntries(included)).map((nested, idx) => {
    const group = nested.head;
    const e = group[0];
    for (const g of [...group, ...nested.modules.flat()]) if (g.written) filled++;
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
    const body = (g: EodEntry, word: string) => `${word}: ${esc(g.systemUpdate)}\nAction Item: ${esc(g.actionItem)}`;
    const bodyOf = (grp: EodEntry[], word: string) => grp.length === 1
      ? body(grp[0], word)
      : grp.map((g) => `${esc(g.by || "Unsigned")}:\n${body(g, word)}`).join("\n\n");
    /*
     * A system's modules, under it: each unit's label, then its update. The
     * word is "Update" rather than "System Update" because it is not the
     * system's. A system nobody wrote on whose detector was written up still
     * reads as the system, with the detector's lines under it.
     */
    const modules = nested.modules.map((m) => `${esc(m[0].label)}:\n${bodyOf(m, "Update")}`);
    // A module whose system is off the report (skipped, say) stands as a
    // unit - and keeps a module's word, as the page does.
    const word = e.kind === "asset" && e.parent ? "Update" : "System Update";
    return `${heading}\n\n${bodyOf(group, word)}${modules.length ? `\n\n${modules.join("\n\n")}` : ""}\n\n${SEP}`;
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
