import { and, asc, eq, desc, inArray, isNull, ne, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "@/db";
import Link from "next/link";
import { instruments, instrumentGases, parts, auditLog, sheetDiffs, tasks, assets, vocabTerms, engagementRecords, orgs, attachments, workOrders } from "@/db/schema";
import { queueView } from "@/lib/queue";
import { getBrand } from "@/lib/brand";
import { shopTime } from "@/lib/shopday";
import { GAS_SYMBOL, gasAttention, partOpen, assetAttention } from "@/lib/stages";
import { expiryAttention, expiryLabel } from "@/lib/gxp";
import { getStageDefs } from "@/lib/stageDefs";
import { systemLabel } from "@/lib/systemLabel";
import { shopToday } from "@/lib/shopday";
import { directoryNames, visibleDirectory } from "@/lib/directory";
import { requireUser } from "@/lib/authz";
import { forTenant, viewTenant, visibleOrgs, visibleSystemIds } from "@/lib/tenancy";
import { clientOptions } from "@/lib/clientNames";
import { shelveRecords } from "@/lib/records";
import { severityOf, woOpen } from "@/lib/workOrders";
import { redirect } from "next/navigation";
import Dashboard from "@/components/Dashboard";

export const dynamic = "force-dynamic";

export default async function Home() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }

  // Staff see the whole shop; an organization sees only what's shared with it.
  // `null` means no restriction - an empty list means nothing, so every query
  // below must go through `mine()`.
  const visible = await visibleSystemIds(user);
  const mine = (col: AnyColumn): SQL | undefined =>
    visible === null ? undefined : visible.length ? inArray(col, visible) : sql`false`;

  const [rows, allParts, allGases, recent, openRowDiffs, stageDefList, peopleRows, taskRows, assetRows, allSystems, vocabCats] = await Promise.all([
    db.select().from(instruments).where(and(eq(instruments.archived, false), mine(instruments.id))).orderBy(asc(instruments.priority), asc(instruments.externalId)),
    db.select().from(parts).where(mine(parts.instrumentId)),
    db.select().from(instrumentGases).where(mine(instrumentGases.instrumentId)),
    db.select().from(auditLog).where(mine(auditLog.instrumentId)).orderBy(desc(auditLog.createdAt)).limit(200),
    db.select().from(sheetDiffs).where(and(eq(sheetDiffs.resolved, false), eq(sheetDiffs.field, "Row"))),
    getStageDefs(await viewTenant(user)),
    // Who work can be assigned to: the logins of the organizations this viewer
    // works with. See lib/directory.
    visibleDirectory(user),
    db.select({ instrumentId: tasks.instrumentId, assetId: tasks.assetId, dueDate: tasks.dueDate, state: tasks.state, assignee: tasks.assignee, title: tasks.title }).from(tasks).where(mine(tasks.instrumentId)),
    db.select({ instrumentId: assets.instrumentId, kind: assets.kind, model: assets.model, status: assets.status, sortOrder: assets.sortOrder }).from(assets).where(mine(assets.instrumentId)),
    // Archived systems included, so retiring the last system for a client (or
    // in a category) doesn't drop it out of the pickers.
    db.select({ client: instruments.client, category: instruments.category }).from(instruments).where(mine(instruments.id)),
    db.select({ name: vocabTerms.name }).from(vocabTerms)
      .where(and(eq(vocabTerms.kind, "category"), forTenant(vocabTerms.tenantOrgId, await viewTenant(user)))),
  ]);
  // Open work orders, for two things the board was blind to: which systems are
  // DOWN right now, and what is on MY plate. Scoped like everything else.
  const woRows = await db.select({
    id: workOrders.id, number: workOrders.number, title: workOrders.title,
    severity: workOrders.severity, state: workOrders.state, assignee: workOrders.assignee,
    instrumentId: workOrders.instrumentId, assetId: workOrders.assetId,
  }).from(workOrders).where(mine(workOrders.instrumentId));
  // Dated paper on regulated systems only - the whole point of the GxP flag is
  // that a loaner's expired delivery note never nags anybody.
  const gxpIds = rows.filter((i) => i.gxp).map((i) => i.id);
  const datedDocs = gxpIds.length
    ? await db.select({ instrumentId: attachments.instrumentId, fileName: attachments.fileName, expiresOn: attachments.expiresOn })
        .from(attachments).where(and(inArray(attachments.instrumentId, gxpIds), ne(attachments.expiresOn, "")))
    : [];

  // Queue holders, named for the row badges. The house's own queue is labelled
  // with the operator's name rather than "us", so a client reading their own
  // board sees who they're waiting on.
  const [orgNames, brand] = await Promise.all([
    visibleOrgs(user),
    getBrand(),
  ]);
  const queueName = (id: number | null) =>
    id === null ? brand.operatorName : orgNames.find((o) => o.id === id)?.name ?? "another organization";

  // An organization's shelf of frozen records: service work whose share was
  // withdrawn, and systems it used to own. Only their own org's, and only the
  // current record for each ending - a superseded one still reads at its URL
  // but doesn't clutter the shelf. lib/records decides what shelves where.
  const frozenRows = user.orgId === null ? [] : await db
    .select({
      id: engagementRecords.id, kind: engagementRecords.kind, instrumentId: engagementRecords.instrumentId,
      externalId: engagementRecords.externalId, label: engagementRecords.label, revokedAt: engagementRecords.revokedAt,
    })
    .from(engagementRecords)
    .where(and(eq(engagementRecords.orgId, user.orgId), isNull(engagementRecords.supersededAt)))
    .orderBy(desc(engagementRecords.revokedAt));
  const { pastEngagements, previouslyOwned } = shelveRecords(frozenRows, new Set(rows.map((r) => r.id)));

  // Systems the client's sheet dropped but we still track (flagged by sheet-sync).
  // Internal parity detail, so staff eyes only.
  const isStaff = user.role === "owner" || user.role === "staff";
  const droppedFromSheet = new Set(
    isStaff ? openRowDiffs.filter((d) => d.sheetValue === "(missing from sheet)").map((d) => d.externalId) : []
  );

  const today = shopToday();
  const overdueBy = new Map<number, number>();
  for (const t of taskRows) {
    // Asset-owned tasks have no system to count against.
    if (t.instrumentId === null || t.state === "Done" || !t.dueDate || t.dueDate >= today) continue;
    overdueBy.set(t.instrumentId, (overdueBy.get(t.instrumentId) ?? 0) + 1);
  }

  const openWos = woRows.filter((w) => woOpen(w.state));
  // A system is DOWN when an open order says so. An asset marked Down already
  // raises its own red pill; the row treats either as down.
  const downByWo = new Set(openWos.filter((w) => w.severity === "Down" && w.instrumentId !== null)
    .map((w) => w.instrumentId as number));

  // What is on MY plate: my open orders worst-first, then my dated open tasks
  // due soonest. Matching by the signed-in name, same as assignment does.
  const meName = (user.name || "").trim().toLowerCase();
  const sysLabelOf = (id: number | null) =>
    id === null ? "" : rows.find((r) => r.id === id)?.externalId ?? "";
  const myWos = meName ? openWos.filter((w) => w.assignee.trim().toLowerCase() === meName) : [];
  const myTasks = meName ? taskRows.filter((t) => t.state !== "Done"
    && t.assignee.trim().toLowerCase() === meName && t.dueDate) : [];
  const myWork = [
    ...myWos
      .sort((a, b) => severityOf(a.severity).rank - severityOf(b.severity).rank)
      .map((w) => ({
        href: `/work/${w.id}`,
        title: `${w.number} ${w.title}`,
        sub: [sysLabelOf(w.instrumentId), severityOf(w.severity).label].filter(Boolean).join(" · "),
        tone: w.severity === "Down" ? "down" as const : "normal" as const,
      })),
    ...myTasks
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      .map((t) => ({
        href: t.instrumentId !== null ? `/instruments/${t.instrumentId}` : t.assetId !== null ? `/assets/${t.assetId}` : "/work",
        title: t.title,
        sub: [sysLabelOf(t.instrumentId), t.dueDate < today ? `overdue since ${t.dueDate}` : t.dueDate === today ? "due today" : `due ${t.dueDate}`].filter(Boolean).join(" · "),
        tone: t.dueDate <= today ? "due" as const : "normal" as const,
      })),
  ].slice(0, 8);

  const data = rows.map((i) => {
    const openParts = allParts.filter((p) => p.instrumentId === i.id && partOpen(p.status)).length;
    const gasIssues = allGases
      .filter((g) => g.instrumentId === i.id && gasAttention(g.status))
      .map((g) => `${GAS_SYMBOL[g.gas] || g.gas} ${g.status === "Not connected" ? "n/c" : g.status.toLowerCase()}`);
    // Regulated systems: certs lapsed or lapsing. See lib/gxp.
    const dated = expiryAttention(datedDocs.filter((d) => d.instrumentId === i.id), today);
    const docIssues = [
      ...dated.expired.map((d) => `${d.fileName} expired`),
      ...dated.soon.map((d) => `${d.fileName} ${expiryLabel(d.expiresOn, today)}`),
    ];
    const last = recent.find((a) => a.instrumentId === i.id);
    return {
      id: i.id,
      externalId: i.externalId,
      client: i.client,
      category: i.category,
      // A system is what it's built from; the stored description is only a
      // fallback for systems whose assets haven't been entered yet.
      label: systemLabel(i, assetRows.filter((a) => a.instrumentId === i.id)),
      priority: i.priority,
      lead: i.lead,
      stages: i.stages,
      notes: i.notes,
      openParts,
      gasIssues,
      docIssues,
      overdue: overdueBy.get(i.id) ?? 0,
      assetIssues: assetRows
        .filter((a) => a.instrumentId === i.id && assetAttention(a.status))
        .map((a) => `${a.kind.toLowerCase()} ${a.status === "Down" ? "down" : "attn"}`),
      missingFromSheet: droppedFromSheet.has(i.externalId),
      lastActivity: last ? `${last.action} - ${last.actor.split("@")[0]}` : "",
      // Whose move it is. A system parked with the client is still visible -
      // hiding it would just move the forgetting somewhere else - but it reads
      // as theirs, and the "Ours to move" filter takes it off the board.
      down: downByWo.has(i.id) || assetRows.some((a) => a.instrumentId === i.id && a.status === "Down"),
      queueMine: queueView(user, i) === "mine",
      queueWith: queueName(i.queueOrgId),
      queueReason: i.queueReason,
    };
  });

  return (
    <>
      <Dashboard
        data={data}
        stageDefs={stageDefList.map((d) => ({ name: d.name, bg: d.bg, fg: d.fg }))}
        people={directoryNames(peopleRows)}
        // Organizations tagged as clients, merged with the names already in use
        // - the picker used to show only the latter, so a client created in
        // Organizations never appeared here. Staff only, for the same reason the
        // system page's picker is: this list is the operator's book of business.
        clients={clientOptions(
          isStaff ? orgNames.filter((o) => o.kind === "client").map((o) => o.name) : [],
          allSystems.map((c) => c.client),
        )}
        categories={[...allSystems.map((c) => c.category), ...vocabCats.map((v) => v.name)].filter(Boolean)}
        canEdit={user.role !== "client_viewer"}
        isStaff={isStaff}
        myWork={myWork}
        myQueueHref={user.name ? `/work?who=${encodeURIComponent(user.name)}` : "/work"}
        // The ship pipeline is the shop's own axis, and a reseller client's.
        // For everyone else "Ship queue + shipped" is a tile about a business
        // they aren't in - same burial as the resale controls.
        showShipping={isStaff || (user.orgId !== null && (orgNames.find((o) => o.id === user.orgId)?.resaleEnabled ?? false))}
      />
      {(pastEngagements.length > 0 || previouslyOwned.length > 0) && (
        <div className="container" style={{ paddingTop: 0 }}>
          {pastEngagements.length > 0 && (
            <FrozenShelf
              title="Past engagements"
              blurb="Systems you serviced until the share was withdrawn. Frozen, read-only, and never updated again."
              verb="access ended"
              rows={pastEngagements}
            />
          )}
          {previouslyOwned.length > 0 && (
            <FrozenShelf
              title="Previously owned"
              blurb="Systems that changed hands. Your record of the tenure stays yours; the live system belongs to whoever holds it now."
              verb="handed on"
              rows={previouslyOwned}
            />
          )}
        </div>
      )}
    </>
  );
}

/**
 * One shelf of frozen records. Both shelves read identically - a link to the
 * dossier and the date it closed - because to the holder they are the same
 * object; only the reason they hold it differs, and that's what the title and
 * blurb carry.
 */
function FrozenShelf({ title, blurb, verb, rows }: {
  title: string; blurb: string; verb: string;
  rows: { id: number; externalId: string; label: string; revokedAt: Date }[];
}) {
  return (
    <div className="card">
      <div className="card-title">{title}</div>
      <div className="mut" style={{ fontSize: 11, marginBottom: 10 }}>{blurb}</div>
      {rows.map((r) => (
        <div key={r.id} style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
          <Link href={`/records/${r.id}`} className="mono" style={{ fontWeight: 700, fontSize: 13, textDecoration: "none", color: "var(--navy)" }}>
            {r.externalId}
          </Link>
          <span style={{ fontSize: 13 }}>{r.label || <span className="mut">No assets were listed</span>}</span>
          <span className="mut" style={{ fontSize: 12, marginLeft: "auto" }}>{verb} {shopTime(r.revokedAt)}</span>
        </div>
      ))}
    </div>
  );
}
