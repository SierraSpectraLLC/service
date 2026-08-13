import { notFound, redirect } from "next/navigation";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import {
  instruments, instrumentGases, tasks, checklistItems, itemNotes, taskNotes, parts, attachments, auditLog,
  discussionPosts, people, assets, discussionReads, vocabTerms, systemShares, orgs, accessRequests, eodUpdates,
  pmSchedules, procedures, signoffs, timeEntries, partPrices, custodyEvents, queueEvents,
} from "@/db/schema";
import { requireUser, viewContext } from "@/lib/authz";
import { assertSystemVisible, canEditSystem, forTenant, viewTenant, visibleOrgs, visibleSystemIds } from "@/lib/tenancy";
import { canSeeCosts, redactParts } from "@/lib/redact";
import { canSeePost, type Audience } from "@/lib/discussionScope";
import { schedulePartsOf } from "@/lib/procedures";
import { scheduleLine } from "@/lib/pmRequest";
import { getBrand } from "@/lib/brand";
import { consentModeFor, remoteAbility } from "@/lib/remoteAccess";
import { linkedDevice } from "@/lib/remote";
import { getModules } from "@/lib/flags";
import { shopDay, shopTime, shopToday } from "@/lib/shopday";
import { getStageDefs } from "@/lib/stageDefs";
import { partOpen, GASES } from "@/lib/stages";
import { systemLabel } from "@/lib/systemLabel";
import SystemPanel from "@/components/SystemPanel";
import ActivityNoteForm from "@/components/ActivityNoteForm";
import ActivityFeed from "@/components/ActivityFeed";
import PartsPanel from "@/components/PartsPanel";
import AttachmentsPanel from "@/components/AttachmentsPanel";
import { storeQuota } from "@/lib/storeUsage";
import TasksPanel from "@/components/TasksPanel";
import MaintenancePanel from "@/components/MaintenancePanel";
import DailyUpdatePanel from "@/components/DailyUpdatePanel";
import HoursPanel from "@/components/HoursPanel";
import DiscussionPanel from "@/components/DiscussionPanel";
import PushToSheetButton from "@/components/PushToSheetButton";
import ClientRequest from "@/components/ClientRequest";
import AssetsPanel from "@/components/AssetsPanel";
import CustodyPanel from "@/components/CustodyPanel";
import QueuePanel from "@/components/QueuePanel";
import PanelLayout from "@/components/PanelLayout";
import { getUiLayout } from "@/app/actions";
import { canKick, daysSince, queueView } from "@/lib/queue";

export const dynamic = "force-dynamic";

export default async function InstrumentPage({ params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { id } = await params;
  const instId = parseInt(id);
  if (isNaN(instId)) notFound();
  // A system nobody shared with you doesn't exist as far as you're concerned.
  try { await assertSystemVisible(user, instId); } catch { notFound(); }
  const visible = await visibleSystemIds(user);
  const mine = (col: AnyColumn): SQL | undefined =>
    visible === null ? undefined : visible.length ? inArray(col, visible) : sql`false`;

  // neon-http makes each query its own round-trip, so batch the independent
  // ones: wave 1 needs only the id, wave 2 needs taskIds, wave 3 itemIds.
  const [[inst], gasRows, taskRows, partRows, attachRows, activity, stageDefList, gasNames, systemRows, vocabRows, discussion, peopleRows, assetRows, unassignedRows, readRows, shareRows, orgRows] = await Promise.all([
    db.select().from(instruments).where(eq(instruments.id, instId)),
    db.select().from(instrumentGases).where(eq(instrumentGases.instrumentId, instId)).orderBy(asc(instrumentGases.id)),
    db.select().from(tasks).where(eq(tasks.instrumentId, instId)).orderBy(asc(tasks.sortOrder), asc(tasks.id)),
    db.select().from(parts).where(eq(parts.instrumentId, instId)).orderBy(asc(parts.id)),
    db.select().from(attachments).where(eq(attachments.instrumentId, instId)).orderBy(desc(attachments.createdAt)),
    db.select().from(auditLog).where(eq(auditLog.instrumentId, instId)).orderBy(desc(auditLog.createdAt)).limit(100),
    getStageDefs(await viewTenant(user)),
    db.selectDistinct({ gas: instrumentGases.gas }).from(instrumentGases),
    db.select({ client: instruments.client, category: instruments.category }).from(instruments).where(mine(instruments.id)),
    db.select().from(vocabTerms).where(forTenant(vocabTerms.tenantOrgId, await viewTenant(user))),
    db.select().from(discussionPosts).where(eq(discussionPosts.instrumentId, instId)).orderBy(asc(discussionPosts.createdAt)),
    db.select({ name: people.name }).from(people)
      .where(forTenant(people.tenantOrgId, await viewTenant(user)))
      .orderBy(asc(people.org), asc(people.name)),
    db.select().from(assets).where(eq(assets.instrumentId, instId)).orderBy(asc(assets.sortOrder), asc(assets.id)),
    // Shelf stock offered for attaching: the house sees all of it; an org sees
    // only units it owns, never another client's spares. Retired units are
    // excluded - attachAsset refuses them anyway, so offering one is a picker
    // that leads to an error message.
    db.select().from(assets).where(and(isNull(assets.instrumentId),
      ne(assets.status, "Decommissioned"),
      user.orgId === null ? undefined : eq(assets.ownerOrgId, user.orgId))).orderBy(asc(assets.kind), asc(assets.model)),
    db.select().from(discussionReads).where(and(eq(discussionReads.userEmail, user.email), eq(discussionReads.threadId, instId))),
    // Who this system is shared with, and who it could be shared with.
    db.select({ orgId: systemShares.orgId, access: systemShares.access, name: orgs.name, kind: orgs.kind })
      .from(systemShares).innerJoin(orgs, eq(orgs.id, systemShares.orgId))
      .where(eq(systemShares.instrumentId, instId)).orderBy(asc(orgs.name)),
    // Only organizations this viewer may know about: the share picker used to
    // ship the whole instance's list to the browser (see visibleOrgs).
    visibleOrgs(user),
  ]);
  // Catalog models for THIS system's type, by asset type: adding a detector to
  // a GC-MS should offer FID and TCD, not every detector the shop knows. A model
  // tagged to no category is universal kit, so it's always offered.
  const catalogModels: Record<string, string[]> = {};
  const gridModels: Record<string, { name: string; manufacturer: string }[]> = {};
  for (const v of vocabRows) {
    if (v.kind !== "model" || !v.assetType) continue;
    if (v.categories.length && !v.categories.some((c) => c.toLowerCase() === inst.category.trim().toLowerCase())) continue;
    (catalogModels[v.assetType] ??= []).push(v.name);
    (gridModels[v.assetType] ??= []).push({ name: v.name, manufacturer: v.manufacturer });
  }

  const showCosts = canSeeCosts(user, inst.ownerOrgId, inst.tenantOrgId);

  // What closed on each day, so the parts fitted that day read as that job's work
  // rather than as forty loose rows - see lib/partGroups.
  const serviceEvents = taskRows
    .filter((t) => t.completedAt !== null)
    .map((t) => ({ day: shopDay(t.completedAt!), title: t.title }));

  // Chain of custody, oldest first - it reads as a story. The reader's own
  // panel arrangement rides along, so the page arrives already arranged.
  const [custodyRows, queueRows, panelLayout] = await Promise.all([
    db.select().from(custodyEvents)
      .where(eq(custodyEvents.instrumentId, instId))
      .orderBy(asc(custodyEvents.at), asc(custodyEvents.id)),
    db.select().from(queueEvents)
      .where(eq(queueEvents.instrumentId, instId))
      .orderBy(desc(queueEvents.at), desc(queueEvents.id)).limit(20),
    getUiLayout("system"),
  ]);

  // Labor on this system, newest first. Work tagged to an installed asset
  // carries instrumentId too (resolveTarget), so one filter catches it all.
  // The price book rides along only for viewers who can see costs at all -
  // it never reaches a browser that lib/redact would blank.
  const [timeRows, priceBook] = await Promise.all([
    db.select().from(timeEntries)
      .where(eq(timeEntries.instrumentId, instId))
      .orderBy(desc(timeEntries.date), desc(timeEntries.id)).limit(100),
    showCosts
      ? db.select({ partNumber: partPrices.partNumber, vendor: partPrices.vendor, isOem: partPrices.isOem, priceCents: partPrices.priceCents })
        .from(partPrices).where(forTenant(partPrices.tenantOrgId, inst.tenantOrgId))
      : Promise.resolve([]),
  ]);

  // The system's own schedules plus those living on its installed assets - a
  // pump's seal job shows up wherever the pump currently works.
  const pmRows = await db.select().from(pmSchedules).where(
    assetRows.length
      ? or(eq(pmSchedules.instrumentId, instId), inArray(pmSchedules.assetId, assetRows.map((a) => a.id)))
      : eq(pmSchedules.instrumentId, instId)
  ).orderBy(asc(pmSchedules.nextDue));
  if (!inst) notFound();
  // Whose storage a file uploaded here would land in - the system's owner, not
  // whoever happens to be looking at it.
  const fileQuota = await storeQuota(inst.ownerOrgId ?? null);

  // An asset can carry work of its own (recorded on its page, with no system).
  // Count it in the per-asset "open" badge so nothing hides on a subpage.
  const assetIds = assetRows.map((a) => a.id);
  const [ownTasks, ownParts] = await Promise.all([
    assetIds.length
      ? db.select({ assetId: tasks.assetId, state: tasks.state }).from(tasks)
          .where(and(isNull(tasks.instrumentId), inArray(tasks.assetId, assetIds)))
      : [],
    assetIds.length
      ? db.select({ assetId: parts.assetId, status: parts.status }).from(parts)
          .where(and(isNull(parts.instrumentId), inArray(parts.assetId, assetIds)))
      : [],
  ]);

  const taskIds = taskRows.map((t) => t.id);
  const [items, tNotes] = await Promise.all([
    taskIds.length ? db.select().from(checklistItems).where(inArray(checklistItems.taskId, taskIds)).orderBy(asc(checklistItems.sortOrder), asc(checklistItems.id)) : [],
    taskIds.length ? db.select().from(taskNotes).where(inArray(taskNotes.taskId, taskIds)).orderBy(asc(taskNotes.createdAt)) : [],
  ]);
  const itemIds = items.map((i) => i.id);
  const iNotes = itemIds.length ? await db.select().from(itemNotes).where(inArray(itemNotes.itemId, itemIds)).orderBy(asc(itemNotes.createdAt)) : [];

  // Which of this system's tasks a report can be filed against, and which of
  // those are mandatory - the ★ in the attachment picker and the sign-off gate.
  const procIds = [...new Set(taskRows.flatMap((t) => (t.procedureId !== null ? [t.procedureId] : [])))];
  const [procRows, signRows] = await Promise.all([
    procIds.length
      ? db.select({ id: procedures.id, kind: procedures.kind, required: procedures.required })
          .from(procedures).where(inArray(procedures.id, procIds))
      : [],
    db.select().from(signoffs).where(and(eq(signoffs.instrumentId, instId), isNull(signoffs.revokedAt))),
  ]);
  const evidenceTasks = taskRows.map((t) => {
    const pr = procRows.find((x) => x.id === t.procedureId);
    return { id: t.id, title: t.title, required: (pr?.required ?? false) && pr?.kind === "test" };
  });

  // A view-level share is read-only even for an org whose role can edit.
  const canEdit = await canEditSystem(user, instId);
  const isStaff = user.role === "owner" || user.role === "staff";
  const modules = await getModules();
  const { persona } = await viewContext();
  // Today's client-facing update, written here and picked up by the EOD page.
  const ownerIsViewer = inst.ownerOrgId !== null && inst.ownerOrgId === user.orgId;
  const [todayUpdate] = modules.eod && (isStaff || ownerIsViewer)
    ? await db.select().from(eodUpdates)
        .where(and(eq(eodUpdates.instrumentId, instId), eq(eodUpdates.date, shopToday())))
    : [];

  // Discussion. The thread is scoped by the system (checked above), but each
  // post carries its own audience: an internal note belongs to the party that
  // wrote it and is invisible to everyone else, this instance's operator
  // included. Names come from the orgs table so a multi-party thread reads as a
  // conversation between companies rather than a wall of first names.
  const brand = await getBrand();

  // The PC that drives this instrument, if one is enrolled against it. Reaching
  // it belongs on the instrument's own page: an engineer who has just read what
  // is wrong with a system should not have to go and find its machine in a list.
  const pc = modules.remote ? await linkedDevice(inst.id) : null;
  const pcAbility = pc
    ? remoteAbility(user, { moduleOn: true, personaActive: persona !== null },
      { orgId: pc.orgId, tenantOrgId: pc.tenantOrgId }, { remoteAccessEnabled: pc.orgRemote ?? false })
    : null;
  const pcConsent = pc
    ? consentModeFor(
      { orgId: pc.orgId, consentOverride: pc.consentOverride },
      { ownerOrgId: inst.ownerOrgId, stages: inst.stages },
    )
    : null;
  const pcOnline = pc?.lastSeenAt != null && Date.now() - pc.lastSeenAt.getTime() < 10 * 60_000;

  const orgName = new Map(orgRows.map((o) => [o.id, o.name]));
  const partyName = (orgId: number | null) => (orgId === null ? brand.operatorName : orgName.get(orgId) ?? "a former organization");
  const viewer = { isHouse: isStaff, orgId: user.orgId };
  const visiblePosts = discussion.filter((p) => canSeePost(viewer, { ...p, audience: p.audience as Audience }));
  const sharedWith = [brand.operatorName, ...shareRows.map((s) => s.name)].join(", ");

  // Pending serial-lookup access requests, for the people who decide them:
  // staff, or the owning organization's editors.
  const isDecider = isStaff || (inst.ownerOrgId !== null && inst.ownerOrgId === user.orgId && user.role === "client_editor");
  const requestRows = isDecider
    ? await db.select({ id: accessRequests.id, kind: accessRequests.kind, requestedBy: accessRequests.requestedBy, message: accessRequests.message, createdAt: accessRequests.createdAt, orgName: orgs.name, orgKind: orgs.kind })
        .from(accessRequests).innerJoin(orgs, eq(orgs.id, accessRequests.orgId))
        .where(and(eq(accessRequests.instrumentId, instId), eq(accessRequests.status, "pending")))
        .orderBy(asc(accessRequests.createdAt))
    : [];

  const fullTasks = taskRows.map((t) => ({
    ...t,
    createdAt: t.createdAt.toISOString(),
    completedAt: t.completedAt?.toISOString() ?? null,
    checklist: items.filter((c) => c.taskId === t.id).map((c) => ({
      ...c,
      thread: iNotes.filter((n) => n.itemId === c.id).map((n) => ({ ...n, createdAt: n.createdAt.toISOString() })),
    })),
    notes: tNotes.filter((n) => n.taskId === t.id).map((n) => ({ ...n, createdAt: n.createdAt.toISOString() })),
  }));

  return (
    <div className="container split">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <Link href="/" className="mut" style={{ fontSize: 13, textDecoration: "none" }}>
          ← All instruments
        </Link>
        <span style={{ marginLeft: "auto" }} />

        {/* Anybody who can see the system can say something is wrong with it, or
            ask for its upkeep - including a read-only account watching an
            instrument fail, who should not have to find somebody with more
            rights first. */}
        {!inst.archived && (
          <>
            <ClientRequest kind="issue" instrumentId={inst.id} externalId={inst.externalId} />
            <ClientRequest kind="pm" instrumentId={inst.id} externalId={inst.externalId}
              nextPm={scheduleLine(pmRows, shopToday())} />
          </>
        )}

        {/* The instrument's own PC. Sits with the other actions on the system
            rather than on a list somewhere else, because it is used in the
            middle of reading this page, not instead of reading it. Last-seen is
            shown rather than an online claim: the cache only refreshes when
            somebody opens the machine list, so "offline" would often be a lie. */}
        {pc && pcAbility?.see && (
          pcAbility.connect ? (
            <Link href={`/remote/${pc.id}`} className="btn sm"
              title={`${pc.name || "The linked PC"} · ${pcOnline ? "online" : pc.lastSeenAt ? `last seen ${shopTime(pc.lastSeenAt)}` : "not seen yet"}`}
              style={{ textDecoration: "none", flexShrink: 0, display: "inline-flex", alignItems: "center", gap: 6 }}>
              <span aria-hidden style={{
                width: 7, height: 7, borderRadius: 999,
                background: pcOnline ? "#2E6B2E" : "#94A3B8",
              }} />
              {pcConsent?.mode === "consent" ? "Request session" : "Connect"}
            </Link>
          ) : pcAbility.refusal ? (
            <span className="mut" style={{ fontSize: 11, flexShrink: 0 }}>{pcAbility.refusal}</span>
          ) : null
        )}

        {isStaff && (
          <>
            {modules.sheetSync && <PushToSheetButton instrumentId={inst.id} externalId={inst.externalId} />}
            <Link href={`/instruments/${inst.id}/label`} className="btn sm" style={{ textDecoration: "none", flexShrink: 0 }}>
              Label
            </Link>
            <Link href={`/instruments/${inst.id}/signoff`} className="btn sm" style={{ textDecoration: "none", flexShrink: 0 }}>
              Sign-off packet
              {signRows.length > 0 && (
                <span className="pill" style={{ background: "#E5F3E5", color: "#2E6B2E", marginLeft: 6 }}>
                  signed{signRows.length > 1 ? ` ×${signRows.length}` : ""}
                </span>
              )}
            </Link>
          </>
        )}
      </div>

      {/* One 760px column wasted a wide monitor and buried half the record
          below three screens of scroll. Two columns from 1200px up, arranged
          by whoever is reading - see PanelLayout. */}
      <PanelLayout
        viewKey="system"
        saved={panelLayout}
        defaultRight={["custody", "files", "hours", "update", "discussion", "activity"]}
        panels={[
          { key: "system", label: "System", node: (
            <SystemPanel
              instrument={{ id: inst.id, externalId: inst.externalId, client: inst.client, category: inst.category, priority: inst.priority, lead: inst.lead, notes: inst.notes, archived: inst.archived, archivedBy: inst.archivedBy, name: inst.name,
                location: inst.location, forSale: inst.forSale, saleNote: inst.saleNote, listingToken: inst.listingToken }}
              label={systemLabel(inst, assetRows)}
              clients={systemRows.map((c) => c.client)}
              categories={[...systemRows.map((c) => c.category), ...vocabRows.filter((v) => v.kind === "category").map((v) => v.name)]}
              stages={inst.stages} stageDefs={stageDefList.map((d) => ({ name: d.name, bg: d.bg, fg: d.fg }))}
              gases={gasRows.map((g) => ({ id: g.id, gas: g.gas, status: g.status, note: g.note }))}
              knownGases={[...new Set([...GASES, ...gasNames.map((g) => g.gas)])]}
              people={peopleRows.map((p) => p.name)}
              shares={shareRows.map((r) => ({ orgId: r.orgId, name: r.name, kind: r.kind, access: r.access }))}
              orgOptions={orgRows}
              accessRequests={requestRows.map((r) => ({
                id: r.id, orgName: r.orgName, orgKind: r.orgKind, kind: r.kind, requestedBy: r.requestedBy,
                message: r.message, when: shopTime(r.createdAt),
              }))}
              ownerOrgId={inst.ownerOrgId}
              canEdit={canEdit} isStaff={isStaff} isOwner={user.role === "owner"}
              canSell={isStaff || (inst.ownerOrgId !== null && inst.ownerOrgId === user.orgId && user.role === "client_editor")}
            />
          ) },
          // Whose move it is. High on the page: on a parked system it's the first thing that explains why nothing is happening.
          { key: "queue", label: "Queue", node: (
            <QueuePanel
              instrumentId={inst.id} externalId={inst.externalId}
              holderName={inst.queueOrgId === null ? brand.operatorName : orgName.get(inst.queueOrgId) ?? "another organization"}
              isMine={queueView(user, inst) === "mine"}
              since={shopTime(inst.queueSince ?? inst.createdAt)}
              days={daysSince(inst.queueSince ?? inst.createdAt, new Date())}
              reason={inst.queueReason}
              legs={queueRows.map((q) => ({
                id: q.id, fromName: q.fromName, toName: q.toName, reason: q.reason,
                actor: q.actor, when: shopTime(q.at),
              }))}
              // Only organizations that can actually open the system.
              options={shareRows.filter((s) => s.orgId !== inst.queueOrgId).map((s) => ({ id: s.orgId, name: s.name, kind: s.kind }))}
              ourName={brand.operatorName}
              canKick={canKick(user, inst)}
            />
          ) },
          { key: "assets", label: "Assets", node: (
            <AssetsPanel
              instrumentId={inst.id}
              assets={assetRows.map((a) => ({
                id: a.id, kind: a.kind, model: a.model, serial: a.serial, status: a.status, note: a.note,
                openItems:
                  taskRows.filter((t) => t.assetId === a.id && t.state !== "Done").length +
                  partRows.filter((pt) => pt.assetId === a.id && partOpen(pt.status)).length +
                  ownTasks.filter((t) => t.assetId === a.id && t.state !== "Done").length +
                  ownParts.filter((pt) => pt.assetId === a.id && partOpen(pt.status)).length,
              }))}
              unassigned={unassignedRows.map((a) => ({
                id: a.id,
                label: `${a.kind} — ${a.model || "(no model)"}${a.serial ? ` SN ${a.serial}` : ""}${a.owner ? ` · ${a.owner}` : ""}${a.status !== "Spare" ? ` · ${a.status}` : ""}${a.location ? ` · ${a.location}` : ""}`,
              }))}
              kinds={vocabRows.filter((v) => v.kind === "asset_type").map((v) => v.name)}
              canEdit={canEdit}
              catalogModels={catalogModels} gridModels={gridModels}
              owners={[...new Set([inst.client, ...systemRows.map((r) => r.client)].filter(Boolean))]}
            />
          ) },
          { key: "tasks", label: "Tasks", node: (
            <TasksPanel target={{ instrumentId: inst.id, assetId: null }} tasks={fullTasks} people={peopleRows.map((p) => p.name)} systemAssets={assetRows.map((a) => ({ id: a.id, label: `${a.kind} — ${a.model || a.serial || "?"}` }))} today={shopToday()} canEdit={canEdit} isStaff={isStaff} />
          ) },
          { key: "maintenance", label: "Maintenance", node: (
            <MaintenancePanel target={{ instrumentId: inst.id, assetId: null }} today={shopToday()} canEdit={canEdit}
              people={peopleRows.map((p) => p.name)}
              schedules={pmRows.map((s) => {
                const onAsset = s.assetId !== null ? assetRows.find((a) => a.id === s.assetId) : undefined;
                return {
                  id: s.id, title: s.title, body: s.body, assignee: s.assignee,
                  everyDays: s.everyDays, nextDue: s.nextDue, lastDone: s.lastDone, paused: s.paused,
                  parts: schedulePartsOf(s),
                  onAsset: onAsset ? `${onAsset.kind} — ${onAsset.model || onAsset.serial || "?"}` : undefined,
                  openTaskId: taskRows.find((t) => t.pmScheduleId === s.id && t.state !== "Done")?.id ?? null,
                };
              })} />
          ) },
          { key: "parts", label: "Parts", node: (
            <PartsPanel target={{ instrumentId: inst.id, assetId: null }}
              parts={redactParts(partRows, user, inst.ownerOrgId, inst.tenantOrgId).map((p) => ({ ...p, createdAt: p.createdAt.toISOString() }))}
              systemAssets={assetRows.map((a) => ({ id: a.id, label: `${a.kind} — ${a.model || a.serial || "?"}` }))}
              canEdit={canEdit} isStaff={isStaff} showCosts={showCosts} priceBook={priceBook}
              serviceEvents={serviceEvents} />
          ) },
          // Provenance, and the handoff that extends it - staff only, because a change of hands needs a witness at the operator.
          { key: "custody", label: "Ownership history", node: (
            <CustodyPanel
              instrumentId={inst.id} externalId={inst.externalId}
              events={custodyRows.map((c) => ({
                id: c.id, kind: c.kind, fromName: c.fromName, toName: c.toName, note: c.note,
                when: shopTime(c.at), actor: c.actor,
              }))}
              ownerName={inst.ownerOrgId === null ? "nobody yet (house-stewarded)" : orgName.get(inst.ownerOrgId) ?? "an unknown organization"}
              providers={shareRows.filter((s) => s.orgId !== inst.ownerOrgId)
                .map((s) => ({ name: s.name, kind: s.kind, access: s.access }))}
              orgOptions={orgRows.filter((o) => o.id !== inst.ownerOrgId)}
              canHandOff={isStaff}
            />
          ) },
          { key: "files", label: "Files", node: (
            <AttachmentsPanel target={{ instrumentId: inst.id, assetId: null }} attachments={attachRows.map(({ url: _url, ...a }) => ({ ...a, createdAt: a.createdAt.toISOString() }))}
              evidenceTasks={evidenceTasks} canEdit={canEdit} isStaff={isStaff}
              listingCuration={inst.forSale && (isStaff || (inst.ownerOrgId !== null && inst.ownerOrgId === user.orgId && user.role === "client_editor"))}
              storage={fileQuota}
              combineTitle={`${inst.externalId} report packet`}
              combineLines={[systemLabel(inst, assetRows), inst.client, `Prepared by ${user.name}`].filter(Boolean)} />
          ) },
          { key: "hours", label: "Hours", node: (
            <HoursPanel target={{ instrumentId: inst.id, assetId: null }}
              entries={timeRows.map((t) => ({ id: t.id, person: t.person, date: t.date, minutes: t.minutes, note: t.note }))}
              people={peopleRows.map((p) => p.name)} defaultPerson={user.name}
              today={shopToday()} canEdit={canEdit} isStaff={isStaff} />
          ) },
          // Today's client-facing note sits with the conversation it feeds, not up in the system's identity block.
          { key: "update", label: "Today's update", node: (
             modules.eod && (isStaff || ownerIsViewer) && (
              <DailyUpdatePanel target={{ instrumentId: inst.id, assetId: null }}
                systemUpdate={todayUpdate?.systemUpdate ?? ""} actionItem={todayUpdate?.actionItem ?? ""}
                updatedBy={todayUpdate?.updatedBy ?? ""} canEdit={isStaff} />
            )
          ) },
          { key: "discussion", label: "Discussion", node: (
            <DiscussionPanel
              instrumentId={inst.id}
              threadId={inst.id}
              posts={visiblePosts.map((p) => ({
                ...p, createdAt: p.createdAt.toISOString(),
                authorParty: partyName(p.authorOrgId), internal: p.audience === "internal",
              }))}
              canEdit={canEdit}
              partyName={partyName(viewer.isHouse ? null : user.orgId)}
              sharedWith={sharedWith}
              newCount={(() => {
                const seen = readRows[0]?.lastSeenAt;
                return visiblePosts.filter((p) => p.authorEmail !== user.email && (!seen || p.createdAt > seen)).length;
              })()}
            />
          ) },
          { key: "activity", label: "Activity", node: (
            <div className="card">
              <div className="card-title">Activity</div>
              <div className="mut" style={{ fontSize: 11, marginBottom: 10 }}>Append-only. Nothing here can be edited or erased.</div>
              {canEdit && <ActivityNoteForm target={{ instrumentId: inst.id, assetId: null }} />}
              <ActivityFeed items={activity.map((a) => ({
                id: a.id, actor: a.actor, action: a.action, field: a.field, newValue: a.newValue,
                when: shopTime(a.createdAt),
              }))} />
            </div>
          ) },
        ]}
      />
    </div>
  );
}
