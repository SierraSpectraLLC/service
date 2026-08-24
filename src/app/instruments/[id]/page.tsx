import { notFound, redirect } from "next/navigation";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import {
  instruments, instrumentGases, tasks, checklistItems, itemNotes, taskNotes, parts, attachments, auditLog,
  discussionPosts, assets, discussionReads, vocabTerms, systemShares, orgs, accessRequests, eodUpdates,
  serviceVisits, workOrders, orgSites,
  pmSchedules, procedures, signoffs, timeEntries, partPrices, custodyEvents, queueEvents,
  catalogRefs, validationDocs, validationSignatures,
} from "@/db/schema";
import { requireUser, viewContext } from "@/lib/authz";
import {
  assertSystemVisible, canEditSystem, forTenant, readTenant, viewTenant, visibleOrgs, visibleSystemIds,
} from "@/lib/tenancy";
import { canSeeCosts, redactParts } from "@/lib/redact";
import { audienceLine, canSeePost, type Audience } from "@/lib/discussionScope";
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
import { copyTargetsFor } from "@/lib/copyTargets";
import { clientOptions } from "@/lib/clientNames";
import { canOfferResale, resaleFlagFor } from "@/lib/owner";
import { pmPosture, postureLine } from "@/lib/pmPosture";
import { sitesFor } from "@/lib/sites";
import { directoryNames, visibleDirectory } from "@/lib/directory";
import {
  fileSrc, isPhotoFile, livingCover, sharedCover, sharesPhotos, stockPhotoForSystem, stockPhotoForUnit,
  stockSrc,
} from "@/lib/photos";
import SystemPanel from "@/components/SystemPanel";
import ActivityNoteForm from "@/components/ActivityNoteForm";
import ActivityFeed from "@/components/ActivityFeed";
import PartsPanel from "@/components/PartsPanel";
import AttachmentsPanel from "@/components/AttachmentsPanel";
import PhotosPanel from "@/components/PhotosPanel";
import { storeQuota } from "@/lib/storeUsage";
import TasksPanel from "@/components/TasksPanel";
import { woOpen } from "@/lib/workOrders";
import WorkOrdersPanel from "@/components/WorkOrdersPanel";
import SiteCard from "@/components/SiteCard";
import MaintenancePanel from "@/components/MaintenancePanel";
import ReferencePanel from "@/components/ReferencePanel";
import { refsForUnits } from "@/lib/catalogRefs";
import { parseModelSpecs } from "@/lib/modelSpecs";
import DailyUpdatePanel from "@/components/DailyUpdatePanel";
import HoursPanel from "@/components/HoursPanel";
import DiscussionPanel from "@/components/DiscussionPanel";
import PushToSheetButton from "@/components/PushToSheetButton";
import ClientRequest from "@/components/ClientRequest";
import AssetsPanel from "@/components/AssetsPanel";
import CustodyPanel from "@/components/CustodyPanel";
import QueuePanel from "@/components/QueuePanel";
import PanelLayout from "@/components/PanelLayout";
import { HeroKebab, RecordHero, type HeroStat } from "@/components/ui";
import { getUiLayout } from "@/app/actions";
import { canKick, daysSince, queueView } from "@/lib/queue";
import { loadTaskTests, testFieldsFor } from "@/lib/taskTests";
import { expiryAttention, packageComplete, packageForSystem, qualsOf, qualStanding } from "@/lib/gxp";
import ValidationPanel from "@/components/ValidationPanel";
import { mentionableOn } from "@/lib/mentionAudience";

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
    // Everyone this viewer may assign work to or @mention: the logins of their
    // own organization and of the ones they work with. See lib/directory.
    visibleDirectory(user),
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
  // Resale controls only where somebody actually resells - see lib/owner.
  const resaleOrgs = await db.select({ id: orgs.id, resaleEnabled: orgs.resaleEnabled }).from(orgs).catch(() => []);

  // What closed on each day, so the parts fitted that day read as that job's work
  // rather than as forty loose rows - see lib/partGroups.
  const serviceEvents = taskRows
    .filter((t) => t.completedAt !== null)
    .map((t) => ({ day: shopDay(t.completedAt!), title: t.title }));
  // A name somebody gave a day themselves beats any list of procedures.
  const visitNames = Object.fromEntries((await db.select({ day: serviceVisits.day, title: serviceVisits.title })
    .from(serviceVisits).where(eq(serviceVisits.instrumentId, inst.id)).catch(() => []))
    .map((v) => [v.day, v.title]));

  // Where this instrument physically is. The owner's sites, and the one it sits
  // at - which the panel needs in full, because the access notes are the part
  // somebody is actually looking for.
  const siteRows = inst.ownerOrgId === null ? [] : await db.select().from(orgSites)
    .where(eq(orgSites.orgId, inst.ownerOrgId)).orderBy(asc(orgSites.name), asc(orgSites.id));
  const siteNow = siteRows.find((r) => r.id === inst.siteId) ?? null;

  // The jobs on this system, newest first - the panel re-sorts what is still
  // owed to the top and folds the finished ones away.
  const woRows = await db.select().from(workOrders)
    .where(eq(workOrders.instrumentId, instId)).orderBy(desc(workOrders.createdAt));

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
  const [procRows, signRows, refRowsAll] = await Promise.all([
    procIds.length
      ? db.select({ id: procedures.id, kind: procedures.kind, required: procedures.required, qualification: procedures.qualification })
          .from(procedures).where(inArray(procedures.id, procIds))
      : [],
    db.select().from(signoffs).where(and(eq(signoffs.instrumentId, instId), isNull(signoffs.revokedAt))),
    // The reference shelf: manuals and field notes filed on this system's
    // modules in the catalog. Filed once, seen on every unit like it.
    db.select().from(catalogRefs).where(forTenant(catalogRefs.tenantOrgId, inst.tenantOrgId))
      .orderBy(asc(catalogRefs.assetType), asc(catalogRefs.model), asc(catalogRefs.id)).catch(() => []),
  ]);
  const refRows = refsForUnits(refRowsAll, assetRows.map((a) => ({ kind: a.kind, model: a.model })));
  // Where a new reference may be filed: each distinct model here, and each type.
  const refScopes = [
    ...[...new Map(assetRows.filter((a) => a.model).map((a) => [`${a.kind}|${a.model}`, a])).values()]
      .map((a) => ({ assetType: a.kind, model: a.model, label: `${a.model} (every unit)` })),
    ...[...new Set(assetRows.map((a) => a.kind))]
      .map((k) => ({ assetType: k, model: "", label: `any ${k.toLowerCase()}` })),
  ];
  const evidenceTasks = taskRows.map((t) => {
    const pr = procRows.find((x) => x.id === t.procedureId);
    return { id: t.id, title: t.title, required: (pr?.required ?? false) && pr?.kind === "test" };
  });

  // The validation shelf, regulated systems only: documents with their
  // signatures, and the package the catalog says this equipment owes.
  const vDocs = inst.gxp
    ? await db.select().from(validationDocs).where(eq(validationDocs.instrumentId, instId)).orderBy(asc(validationDocs.id))
    : [];
  const vSigs = vDocs.length
    ? await db.select().from(validationSignatures)
        .where(inArray(validationSignatures.docId, vDocs.map((d) => d.id))).orderBy(asc(validationSignatures.id))
    : [];
  const requiredTypes = inst.gxp ? packageForSystem(vocabRows, inst.category, assetRows) : [];

  // A regulated system's standing, derived fresh on every read - the same rule
  // as agreement balances: a stored status is a status that drifts. Unregulated
  // systems skip all of it. See lib/gxp.
  const expiry = expiryAttention(
    // Dated attachments and validation review dates lapse the same way.
    [...attachRows, ...vDocs.filter((d) => d.state !== "Superseded").map((d) => ({ expiresOn: d.reviewOn }))],
    shopToday(),
  );
  const gxpStanding = inst.gxp
    ? qualStanding({
        quals: qualsOf(taskRows.map((t) => ({
          qualification: procRows.find((x) => x.id === t.procedureId)?.qualification ?? "",
          state: t.state,
        }))),
        expired: expiry.expired.length,
        expiringSoon: expiry.soon.length,
        packageComplete: packageComplete(requiredTypes, vDocs),
      })
    : null;

  // A view-level share is read-only even for an org whose role can edit.
  const canEdit = await canEditSystem(user, instId);
  // Other systems this person may write to, for copying a batch of tasks across.
  const copyTargets = canEdit ? await copyTargetsFor(user, instId) : [];
  const isStaff = user.role === "owner" || user.role === "staff";
  const modules = await getModules();
  const { persona } = await viewContext();
  // ---- photos -------------------------------------------------------------
  // A system with exactly one unit IS that unit (see lib/photos), so the two
  // pool their photos rather than each being photographed separately.
  const soloUnit = sharesPhotos(assetRows.length) ? assetRows[0] : null;
  const unitAttachRows = soloUnit
    ? await db.select().from(attachments).where(eq(attachments.assetId, soloUnit.id))
    : [];
  // What makes an attachment a photograph is the file, not what somebody picked
  // in a dropdown when they filed it.
  const photoRows = [...attachRows, ...unitAttachRows].filter(isPhotoFile);
  // livingCover, not the raw pointer: a cover whose file has been deleted would
  // otherwise leave the thumbnail asking for a 404 with no fall back to the
  // catalog's stand-in, because the page believed it had one.
  const coverId = livingCover(photoRows, sharedCover(inst.photoAttachmentId, soloUnit?.photoAttachmentId ?? null));
  const coverFraming = photoRows.find((a) => a.id === coverId)?.framing ?? "";
  // Stock photos live on the catalog row, not on any record. A one-unit system
  // is better illustrated by its module's model than by "LC-MS".
  const catalogPhotos = vocabRows.filter((v) => v.photoUrl);
  const systemStock = (soloUnit && stockPhotoForUnit(catalogPhotos, soloUnit.kind, soloUnit.model))
    || stockPhotoForSystem(catalogPhotos, inst.category);
  const coverSrc = coverId !== null ? fileSrc(coverId) : systemStock ? stockSrc(systemStock.id) : "";
  // Each unit's own cover lives on the unit, so its framing has to be fetched -
  // otherwise the row of thumbnails is the one place a sideways photo stays
  // sideways.
  const assetCoverIds = assetRows.map((a) => a.photoAttachmentId).filter((id): id is number => id != null);
  const assetFraming = new Map((assetCoverIds.length
    ? await db.select({ id: attachments.id, framing: attachments.framing })
        .from(attachments).where(inArray(attachments.id, assetCoverIds))
    : []).map((a) => [a.id, a.framing]));
  /** A unit's thumbnail in the list: its own photo, else what the catalog says that model looks like. */
  const unitPhoto = (a: { kind: string; model: string; photoAttachmentId: number | null }) => {
    if (a.photoAttachmentId != null) {
      return { photoSrc: fileSrc(a.photoAttachmentId), photoFraming: assetFraming.get(a.photoAttachmentId) ?? "" };
    }
    const s = stockPhotoForUnit(catalogPhotos, a.kind, a.model);
    return { photoSrc: s ? stockSrc(s.id) : "", photoFraming: s?.photoFraming ?? "" };
  };
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
  // Which house. On a system shared in from another service company, their staff
  // are a provider on it, not its house - so its house's internal notes are not
  // theirs to read. See lib/discussionScope.
  const viewer = { isHouse: isStaff, orgId: user.orgId, houseOrgId: isStaff ? readTenant(user) : null };
  const visiblePosts = discussion.filter((p) => canSeePost(viewer, { ...p, audience: p.audience as Audience }));
  const sharedWith = audienceLine(brand.operatorName, shareRows.map((s) => s.name));

  // Pending serial-lookup access requests, for the people who decide them:
  // staff, or the owning organization's editors.
  const isDecider = isStaff || (inst.ownerOrgId !== null && inst.ownerOrgId === user.orgId && user.role === "client_editor");
  const requestRows = isDecider
    ? await db.select({ id: accessRequests.id, kind: accessRequests.kind, requestedBy: accessRequests.requestedBy, message: accessRequests.message, createdAt: accessRequests.createdAt, orgName: orgs.name, orgKind: orgs.kind })
        .from(accessRequests).innerJoin(orgs, eq(orgs.id, accessRequests.orgId))
        .where(and(eq(accessRequests.instrumentId, instId), eq(accessRequests.status, "pending")))
        .orderBy(asc(accessRequests.createdAt))
    : [];

  // Which of these are tests, and what each one read - see lib/taskTests.
  const taskTests = await loadTaskTests(taskRows);
  const fullTasks = taskRows.map((t) => ({
    ...t,
    ...testFieldsFor(taskTests, t.id),
    createdAt: t.createdAt.toISOString(),
    completedAt: t.completedAt?.toISOString() ?? null,
    checklist: items.filter((c) => c.taskId === t.id).map((c) => ({
      ...c,
      thread: iNotes.filter((n) => n.itemId === c.id).map((n) => ({ ...n, createdAt: n.createdAt.toISOString() })),
    })),
    notes: tNotes.filter((n) => n.taskId === t.id).map((n) => ({ ...n, createdAt: n.createdAt.toISOString() })),
  }));

  // Who the composer may offer for an @mention: this record's readers, and
  // nobody else - see lib/mentionAudience.
  const mentionable = await mentionableOn(peopleRows, { instrumentId: instId, assetId: null });

  // The hero's stats line: the record's open questions as numbers, before
  // any panel. Only what needs an eye gets a tone.
  const today = shopToday();
  const openWos = woRows.filter((w) => woOpen(w.state));
  const openTasks = taskRows.filter((t) => t.state !== "Done");
  const overdueTasks = openTasks.filter((t) => t.dueDate && t.dueDate < today).length;
  const pmDue = pmRows.filter((sc) => !sc.paused && sc.nextDue <= today).length;
  const queueMine = queueView(user, inst) === "mine";
  const queueDays = daysSince(inst.queueSince ?? inst.createdAt, new Date());
  const heroStats: HeroStat[] = [
    { value: openWos.length, label: `open WO${openWos.length === 1 ? "" : "s"}`, tone: openWos.length ? "warn" : undefined },
    { value: openTasks.length, label: "open tasks", tone: overdueTasks ? "bad" : undefined },
    ...(pmDue ? [{ value: pmDue, label: "PM due", tone: "warn" as const }] : []),
    ...(!queueMine ? [{ value: `${queueDays}d`, label: `with ${partyName(inst.queueOrgId)}`, tone: "warn" as const }] : []),
    ...(gxpStanding && gxpStanding.tone !== "ok"
      ? [{ value: "docs", label: "need attention", tone: (gxpStanding.tone === "bad" ? "bad" : "warn") as HeroStat["tone"] }]
      : []),
  ];

  return (
    <div className="container split">
      <div className="crumb">
        <Link href="/" style={{ textDecoration: "none", color: "inherit" }}>Instruments</Link> › <b>{inst.externalId}</b>
      </div>

      <RecordHero
        image={coverSrc || undefined}
        imageAlt={systemLabel(inst, assetRows)}
        eyebrow={<>{inst.client}{inst.category ? <> · {inst.category}</> : null}{inst.archived ? " · archived" : ""}</>}
        id={inst.externalId}
        title={systemLabel(inst, assetRows) || "No assets listed yet"}
        meta={[inst.location, inst.lead && `lead ${inst.lead}`, `P${inst.priority}`].filter(Boolean).join(" · ")}
        stats={heroStats}
        actions={
          <>
            {/* Anybody who can see the system can ask for help with it -
                including a read-only account watching an instrument fail. */}
            {!inst.archived && (
              <ClientRequest instrumentId={inst.id} externalId={inst.externalId}
                nextPm={scheduleLine(pmRows, shopToday())} />
            )}
            {/* The instrument's own PC, used in the middle of reading this
                page. Last-seen rather than an online claim: the cache only
                refreshes when somebody opens the machine list. */}
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
                <span className="mut t-meta" style={{ flexShrink: 0 }}>{pcAbility.refusal}</span>
              ) : null
            )}
            {isStaff && modules.sheetSync && <PushToSheetButton instrumentId={inst.id} externalId={inst.externalId} />}
          </>
        }
        kebab={
          <HeroKebab arrange menuLabel={`Actions for ${inst.externalId}`}
            items={isStaff ? [
              { label: `Sign-off packet${signRows.length ? ` (signed${signRows.length > 1 ? ` ×${signRows.length}` : ""})` : ""}`, href: `/instruments/${inst.id}/signoff` },
              { label: "Label", href: `/instruments/${inst.id}/label` },
              { label: "Binder", href: `/instruments/${inst.id}/binder` },
            ] : []} />
        }
      />

      {/* One 760px column wasted a wide monitor and buried half the record
          below three screens of scroll. Two columns from 1200px up, arranged
          by whoever is reading - see PanelLayout. */}
      <PanelLayout
        viewKey="system"
        saved={panelLayout}
        // Balanced per TAB, not per page: each tab splits its own panels
        // across the two columns, and the queue card rides beside the header
        // so whose-move-is-it is visible whatever tab is open.
        defaultRight={["queue", "workorders", "parts", "site", "custody", "photos", "reference", "hours", "update"]}
        // The identity card stays on screen; the other fourteen panels were
        // three screens of scroll, so they group into working contexts. Badges
        // are each tab's reason to be visited now, so flipping is navigation
        // rather than hunting.
        pinned={["queue"]}
        // Six working contexts instead of four catch-alls: Now is whose move
        // it is and who holds it; Work is the jobs; Configuration is what the
        // system IS; Files and History split paper from log.
        groups={[
          { key: "now", label: "Now", keys: ["queue", "custody"],
            badge: !queueMine ? `${queueDays}d` : undefined, badgeTone: "warn" },
          { key: "work", label: "Work",
            keys: ["workorders", "tasks", "hours", "parts", "discussion"],
            badge: openTasks.length || undefined,
            badgeTone: overdueTasks ? "bad" : "info" },
          { key: "maintenance", label: "Maintenance", keys: ["maintenance"],
            badge: pmDue || undefined, badgeTone: "warn" },
          { key: "config", label: "Configuration", keys: ["system", "assets", "site", "validation"],
            badge: gxpStanding && gxpStanding.tone !== "ok" ? "!" : undefined,
            badgeTone: gxpStanding?.tone === "bad" ? "bad" : "warn" },
          { key: "files", label: "Files", keys: ["files", "photos", "reference"] },
          { key: "history", label: "History",
            keys: ["activity", "update"],
            badge: (() => {
              const seen = readRows[0]?.lastSeenAt;
              return visiblePosts.filter((x) => x.authorEmail !== user.email && (!seen || x.createdAt > seen)).length || undefined;
            })() },
        ]}
        panels={[
          { key: "system", label: "System", node: (
            <SystemPanel
              instrument={{ id: inst.id, externalId: inst.externalId, client: inst.client, category: inst.category, priority: inst.priority, gxp: inst.gxp, lead: inst.lead, notes: inst.notes, archived: inst.archived, archivedBy: inst.archivedBy, name: inst.name, blockedReason: inst.blockedReason,
                location: inst.location, forSale: inst.forSale, saleNote: inst.saleNote, listingToken: inst.listingToken,
                photoSrc: coverSrc, photoFraming: coverId !== null ? coverFraming : systemStock?.photoFraming ?? "",
                photoIsStock: coverId === null && systemStock !== null }}
              gxpStanding={gxpStanding}
              label={systemLabel(inst, assetRows)}
              // Companies, not just the strings already typed onto systems -
              // see lib/clientNames for what that was hiding. Staff only: the
              // workspace's client list is the operator's book of business, and
              // shipping it to one client's browser so they can relabel their
              // own system would hand them the names of the others.
              clients={clientOptions(
                isStaff ? orgRows.filter((o) => o.kind === "client").map((o) => o.name) : [],
                systemRows.map((c) => c.client),
              )}
              categories={[...systemRows.map((c) => c.category), ...vocabRows.filter((v) => v.kind === "category").map((v) => v.name)]}
              stages={inst.stages} stageDefs={stageDefList.map((d) => ({ name: d.name, bg: d.bg, fg: d.fg }))}
              gases={gasRows.map((g) => ({ id: g.id, gas: g.gas, status: g.status, note: g.note }))}
              knownGases={[...new Set([...GASES, ...gasNames.map((g) => g.gas)])]}
              people={directoryNames(peopleRows)}
              shares={shareRows.map((r) => ({ orgId: r.orgId, name: r.name, kind: r.kind, access: r.access }))}
              orgOptions={orgRows}
              accessRequests={requestRows.map((r) => ({
                id: r.id, orgName: r.orgName, orgKind: r.orgKind, kind: r.kind, requestedBy: r.requestedBy,
                message: r.message, when: shopTime(r.createdAt),
              }))}
              ownerOrgId={inst.ownerOrgId}
              canEdit={canEdit} isStaff={isStaff} isOwner={user.role === "owner"}
              canSell={canOfferResale({
                isStaff, viewerOrgId: user.orgId, viewerRole: user.role,
                ownerOrgId: inst.ownerOrgId,
                ownerResaleEnabled: resaleFlagFor(inst.ownerOrgId, resaleOrgs, user.operatorOrgId ?? null),
                alreadyListed: inst.forSale,
              })}
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
              assets={assetRows.map((a) => {
                // The model's spec sheet rides along, for the row's fold-out.
                const term = a.model ? vocabRows.find((v) => v.kind === "model"
                  && v.assetType.trim().toLowerCase() === a.kind.trim().toLowerCase()
                  && v.name.trim().toLowerCase() === a.model.trim().toLowerCase()) : undefined;
                return ({
                id: a.id, kind: a.kind, model: a.model, serial: a.serial, status: a.status, note: a.note,
                servesAssetId: a.servesAssetId, servesRole: a.servesRole,
                specs: term ? parseModelSpecs(term.specs) : [],
                specTermId: term?.id ?? null,
                ...unitPhoto(a),
                openItems:
                  taskRows.filter((t) => t.assetId === a.id && t.state !== "Done").length +
                  partRows.filter((pt) => pt.assetId === a.id && partOpen(pt.status)).length +
                  ownTasks.filter((t) => t.assetId === a.id && t.state !== "Done").length +
                  ownParts.filter((pt) => pt.assetId === a.id && partOpen(pt.status)).length,
              });})}
              unassigned={unassignedRows.map((a) => ({
                id: a.id,
                label: `${a.kind} - ${a.model || "(no model)"}${a.serial ? ` SN ${a.serial}` : ""}${a.owner ? ` · ${a.owner}` : ""}${a.status !== "Spare" ? ` · ${a.status}` : ""}${a.location ? ` · ${a.location}` : ""}`,
              }))}
              kinds={vocabRows.filter((v) => v.kind === "asset_type").map((v) => v.name)}
              canEdit={canEdit}
              catalogModels={catalogModels} gridModels={gridModels}
              owners={[...new Set([inst.client, ...systemRows.map((r) => r.client)].filter(Boolean))]}
              // The maker book plus every maker on a catalog model - already
              // loaded here, so no extra queries for a suggestion list.
              staff={isStaff}
              makers={[...new Set(vocabRows.filter((t) => t.kind === "maker").map((t) => t.name)
                .concat(vocabRows.filter((t) => t.kind === "model").map((t) => t.manufacturer))
                .filter(Boolean))].sort()}
            />
          ) },
          // Where it physically is, and what a tech needs before driving there.
          { key: "site", label: "Site", node: (
            <SiteCard
              instrumentId={inst.id} siteId={inst.siteId} ownerOrgId={inst.ownerOrgId}
              canEdit={canEdit} isStaff={isStaff}
              options={sitesFor(siteRows, inst.ownerOrgId, inst.siteId)
                .map((r) => ({ id: r.id, name: r.name, address: r.address, archived: r.archived }))}
              site={siteNow ? {
                name: siteNow.name, address: siteNow.address, accessNotes: siteNow.accessNotes,
                contactName: siteNow.contactName, contactPhone: siteNow.contactPhone,
              } : null} />
          ) },
          // What has been asked for and what came of it. Above tasks on purpose:
          // a task list answers "what is there to do", a work order answers
          // "what did the client ask us for and is it finished".
          { key: "workorders", label: "Work orders", node: (
            <WorkOrdersPanel
              target={{ instrumentId: inst.id, assetId: null }}
              today={shopToday()} canEdit={canEdit}
              people={isStaff ? directoryNames(peopleRows) : []}
              orders={woRows.map((w) => {
                const mine = taskRows.filter((t) => t.workOrderId === w.id);
                return {
                  id: w.id, number: w.number, title: w.title, severity: w.severity,
                  state: w.state, assignee: w.assignee, openedOn: w.openedOn,
                  askedBy: w.orgId === null ? brand.operatorName : orgName.get(w.orgId) ?? "",
                  tasks: mine.length, done: mine.filter((t) => t.state === "Done").length,
                };
              })} />
          ) },
          { key: "tasks", label: "Tasks", node: (
            <TasksPanel target={{ instrumentId: inst.id, assetId: null }} tasks={fullTasks} people={directoryNames(peopleRows)} mentionable={mentionable} systemAssets={assetRows.map((a) => ({ id: a.id, label: `${a.kind} - ${a.model || a.serial || "?"}` }))} today={shopToday()} canEdit={canEdit} isStaff={isStaff} copyTargets={copyTargets}
              // Open jobs, so their tasks fold under one band per job here.
              jobs={woRows.filter((w) => woOpen(w.state)).map((w) => ({ id: w.id, number: w.number, title: w.title, state: w.state }))} />
          ) },
          { key: "maintenance", label: "Maintenance", node: (
            <MaintenancePanel target={{ instrumentId: inst.id, assetId: null }} today={shopToday()} canEdit={canEdit}
              catalogHint={isStaff}
              // Scheduled vs advisory (lib/pmPosture): a reseller's systems
              // carry their calendar as reference. The toggle is the house's -
              // it changes what the cron does, which is operator machinery.
              posture={{
                effective: pmPosture(inst.pmPosture, resaleFlagFor(inst.ownerOrgId, resaleOrgs, user.operatorOrgId ?? null)),
                stored: inst.pmPosture,
                note: postureLine(inst.pmPosture,
                  resaleFlagFor(inst.ownerOrgId, resaleOrgs, user.operatorOrgId ?? null),
                  inst.ownerOrgId !== null ? orgName.get(inst.ownerOrgId) ?? "" : ""),
                instrumentId: inst.id,
                canToggle: isStaff,
              }}
              people={directoryNames(peopleRows)}
              schedules={pmRows.map((s) => {
                const onAsset = s.assetId !== null ? assetRows.find((a) => a.id === s.assetId) : undefined;
                return {
                  id: s.id, title: s.title, body: s.body, assignee: s.assignee,
                  everyDays: s.everyDays, nextDue: s.nextDue, lastDone: s.lastDone, paused: s.paused,
                  parts: schedulePartsOf(s),
                  onAsset: onAsset ? `${onAsset.kind} - ${onAsset.model || onAsset.serial || "?"}` : undefined,
                  assetId: s.assetId,
                  openTaskId: taskRows.find((t) => t.pmScheduleId === s.id && t.state !== "Done")?.id ?? null,
                };
              })} />
          ) },
          { key: "parts", label: "Parts", node: (
            <PartsPanel target={{ instrumentId: inst.id, assetId: null }}
              parts={redactParts(partRows, user, inst.ownerOrgId, inst.tenantOrgId).map((p) => ({ ...p, createdAt: p.createdAt.toISOString() }))}
              systemAssets={assetRows.map((a) => ({ id: a.id, label: `${a.kind} - ${a.model || a.serial || "?"}` }))}
              canEdit={canEdit} isStaff={isStaff} showCosts={showCosts} priceBook={priceBook}
              serviceEvents={serviceEvents} visitNames={visitNames}
              moduleTypes={vocabRows.filter((v) => v.kind === "asset_type").map((v) => v.name)}
              pmJobs={pmRows.map((r) => ({ id: r.id, title: r.title }))} />
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
          { key: "photos", label: "Photos", node: (
            <PhotosPanel target={{ instrumentId: inst.id, assetId: null }} coverId={coverId}
              catalogScopes={isStaff ? refScopes : []}
              photos={photoRows.map((a) => ({
                id: a.id, fileName: a.fileName, kind: a.kind, framing: a.framing,
                uploadedBy: a.uploadedBy, when: shopTime(a.createdAt), createdAt: a.createdAt.toISOString(),
              }))}
              label={`${inst.externalId} - ${systemLabel(inst, assetRows) || "the system"}`}
              canEdit={canEdit} storageFull={fileQuota.state === "full"}
              shared={soloUnit ? `${soloUnit.kind}${soloUnit.model ? ` ${soloUnit.model}` : ""}` : undefined} />
          ) },
          // The validation shelf renders only on regulated systems - the GxP
          // flag gates every compliance surface, so this key simply isn't in
          // the list otherwise.
          ...(inst.gxp ? [{ key: "validation", label: "Validation", node: (
            <ValidationPanel instrumentId={inst.id}
              docs={vDocs.map((d) => ({
                id: d.id, docType: d.docType, title: d.title, state: d.state, version: d.version,
                supersedesId: d.supersedesId, attachmentId: d.attachmentId, reviewOn: d.reviewOn,
                note: d.note, createdBy: d.createdBy, createdAt: d.createdAt.toISOString(),
                signatures: vSigs.filter((x) => x.docId === d.id).map((x) => ({
                  id: x.id, role: x.role, signerName: x.signerName, signerTitle: x.signerTitle, note: x.note,
                  createdAt: x.createdAt.toISOString(), revokedAt: x.revokedAt?.toISOString() ?? null,
                  revokeReason: x.revokeReason,
                })),
              }))}
              requiredTypes={requiredTypes}
              files={attachRows.map((a) => ({ id: a.id, fileName: a.fileName }))}
              standing={gxpStanding} isStaff={isStaff} today={shopToday()} />
          ) }] : []),
          { key: "files", label: "Files", node: (
            <AttachmentsPanel target={{ instrumentId: inst.id, assetId: null }} today={shopToday()} attachments={attachRows.map(({ url: _url, ...a }) => ({ ...a, createdAt: a.createdAt.toISOString() }))}
              evidenceTasks={evidenceTasks} canEdit={canEdit} isStaff={isStaff}
              listingCuration={inst.forSale && (isStaff || (inst.ownerOrgId !== null && inst.ownerOrgId === user.orgId && user.role === "client_editor"))}
              storage={fileQuota}
              combineTitle={`${inst.externalId} report packet`}
              combineLines={[systemLabel(inst, assetRows), inst.client, `Prepared by ${user.name}`].filter(Boolean)} />
          ) },
          // The model's accumulated knowledge - manuals, field notes - filed on
          // the catalog, so this panel is identical on every unit like these.
          { key: "reference", label: "Reference", node: (
            <ReferencePanel canEdit={isStaff} scopes={refScopes}
              refs={refRows.map((r) => ({
                id: r.id, assetType: r.assetType, model: r.model, kind: r.kind,
                title: r.title, url: r.url, body: r.body, createdBy: r.createdBy,
                provenance: r.provenance,
                when: shopDay(r.createdAt),
              }))} />
          ) },
          { key: "hours", label: "Hours", node: (
            <HoursPanel target={{ instrumentId: inst.id, assetId: null }}
              entries={timeRows.map((t) => ({ id: t.id, person: t.person, date: t.date, minutes: t.minutes, note: t.note, billable: t.billable, category: t.category }))}
              people={directoryNames(peopleRows)} defaultPerson={user.name}
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
            <DiscussionPanel people={mentionable}
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
