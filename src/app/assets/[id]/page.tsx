import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  assets, assetEvents, tasks, parts, timeEntries, instruments, instrumentGases,
  attachments, checklistItems, itemNotes, taskNotes, auditLog, people, assetShares, orgs, eodUpdates,
  pmSchedules, vocabTerms, procedures,
} from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { assetAccess, visibleSystemIds } from "@/lib/tenancy";
import { canSeeCosts, redactParts } from "@/lib/redact";
import SharePanel from "@/components/SharePanel";
import SalePanel from "@/components/SalePanel";
import DailyUpdatePanel from "@/components/DailyUpdatePanel";
import { getModules } from "@/lib/flags";
import { shopTime, shopToday } from "@/lib/shopday";
import { formatHours } from "@/lib/hours";
import { GASES } from "@/lib/stages";
import { schedulePartsOf } from "@/lib/procedures";
import { mergeAssetHistory } from "@/lib/assetHistory";
import AssetControls from "@/components/AssetControls";
import GasPanel from "@/components/GasPanel";
import PartsPanel from "@/components/PartsPanel";
import AttachmentsPanel from "@/components/AttachmentsPanel";
import TasksPanel from "@/components/TasksPanel";
import MaintenancePanel from "@/components/MaintenancePanel";
import ActivityNoteForm from "@/components/ActivityNoteForm";
import ActivityFeed from "@/components/ActivityFeed";
import RunCheckoutButton from "@/components/RunCheckoutButton";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = { event: "", task: "Task", part: "Part", time: "Time" };

export default async function AssetPage({ params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { id } = await params;
  const assetId = parseInt(id);
  if (isNaN(assetId)) notFound();
  const access = await assetAccess(user, assetId);
  if (!access.see) notFound();
  // History spans every system this unit has lived in - name only the ones the
  // viewer is allowed to know about.
  const visibleSystems = await visibleSystemIds(user);

  const [[asset], events, taggedTasks, taggedParts, taggedTime, insts, ownerRows, vocab,
         gasRows, gasNames, attachRows, activity, peopleRows] = await Promise.all([
    db.select().from(assets).where(eq(assets.id, assetId)),
    db.select().from(assetEvents).where(eq(assetEvents.assetId, assetId)),
    db.select().from(tasks).where(eq(tasks.assetId, assetId)).orderBy(asc(tasks.sortOrder), asc(tasks.id)),
    db.select().from(parts).where(eq(parts.assetId, assetId)).orderBy(asc(parts.id)),
    db.select().from(timeEntries).where(eq(timeEntries.assetId, assetId)),
    db.select({ id: instruments.id, externalId: instruments.externalId, model: instruments.model, client: instruments.client, archived: instruments.archived })
      .from(instruments)
      .where(visibleSystems === null ? undefined : visibleSystems.length ? inArray(instruments.id, visibleSystems) : sql`false`)
      .orderBy(asc(instruments.externalId)),
    db.selectDistinct({ owner: assets.owner }).from(assets),
    db.select().from(vocabTerms),
    db.select().from(instrumentGases).where(eq(instrumentGases.assetId, assetId)).orderBy(asc(instrumentGases.id)),
    db.selectDistinct({ gas: instrumentGases.gas }).from(instrumentGases),
    db.select().from(attachments).where(eq(attachments.assetId, assetId)).orderBy(desc(attachments.createdAt)),
    db.select().from(auditLog).where(eq(auditLog.assetId, assetId)).orderBy(desc(auditLog.createdAt)).limit(100),
    db.select({ name: people.name }).from(people).orderBy(asc(people.org), asc(people.name)),
  ]);
  if (!asset) notFound();

  // Checklists and note threads for this asset's tasks (same shape the system page uses).
  const taskIds = taggedTasks.map((t) => t.id);
  const [items, tNotes] = await Promise.all([
    taskIds.length ? db.select().from(checklistItems).where(inArray(checklistItems.taskId, taskIds)).orderBy(asc(checklistItems.sortOrder), asc(checklistItems.id)) : [],
    taskIds.length ? db.select().from(taskNotes).where(inArray(taskNotes.taskId, taskIds)).orderBy(asc(taskNotes.createdAt)) : [],
  ]);
  const itemIds = items.map((i) => i.id);
  const iNotes = itemIds.length ? await db.select().from(itemNotes).where(inArray(itemNotes.itemId, itemIds)).orderBy(asc(itemNotes.createdAt)) : [];

  // Reports can be filed against this unit's own tasks; ★ marks the mandatory
  // tests that must be evidenced before sign-off.
  const procIds = [...new Set(taggedTasks.flatMap((t) => (t.procedureId !== null ? [t.procedureId] : [])))];
  const procRows = procIds.length
    ? await db.select({ id: procedures.id, kind: procedures.kind, required: procedures.required })
        .from(procedures).where(inArray(procedures.id, procIds))
    : [];
  const evidenceTasks = taggedTasks.map((t) => {
    const pr = procRows.find((x) => x.id === t.procedureId);
    return { id: t.id, title: t.title, required: (pr?.required ?? false) && pr?.kind === "test" };
  });

  const canEdit = access.edit;
  const isStaff = user.role === "owner" || user.role === "staff";
  const canSell = isStaff || (asset.ownerOrgId !== null && asset.ownerOrgId === user.orgId && user.role === "client_editor");

  // Who this asset's dossier is shared with (beyond its system and its owner).
  const [shareRows, orgRows] = await Promise.all([
    db.select({ orgId: assetShares.orgId, access: assetShares.access, name: orgs.name, kind: orgs.kind })
      .from(assetShares).innerJoin(orgs, eq(orgs.id, assetShares.orgId))
      .where(eq(assetShares.assetId, assetId)).orderBy(asc(orgs.name)),
    db.select({ id: orgs.id, name: orgs.name, kind: orgs.kind }).from(orgs).orderBy(asc(orgs.name)),
  ]);
  // Costs follow the owner of whatever the part sits on: the home system's
  // owning org while installed, the asset's own org on the shelf.
  const [homeOwner] = asset.instrumentId !== null
    ? await db.select({ ownerOrgId: instruments.ownerOrgId }).from(instruments).where(eq(instruments.id, asset.instrumentId))
    : [];
  const showCosts = canSeeCosts(user, asset.instrumentId !== null ? homeOwner?.ownerOrgId ?? null : asset.ownerOrgId);
  // Today's client-facing update for this unit, picked up by the EOD page.
  const modules = await getModules();
  const ownerIsViewer = asset.ownerOrgId !== null && asset.ownerOrgId === user.orgId;
  const [todayUpdate] = modules.eod && (isStaff || ownerIsViewer)
    ? await db.select().from(eodUpdates)
        .where(and(eq(eodUpdates.assetId, assetId), eq(eodUpdates.date, shopToday())))
    : [];
  const label = new Map(insts.map((i) => [i.id, i.externalId]));
  const home = asset.instrumentId !== null ? insts.find((i) => i.id === asset.instrumentId) : undefined;
  const totalMinutes = taggedTime.reduce((n, t) => n + t.minutes, 0);
  const target = { instrumentId: null, assetId: asset.id };
  // The unit's own recurring upkeep, wherever it currently sits.
  const pmRows = await db.select().from(pmSchedules).where(eq(pmSchedules.assetId, assetId)).orderBy(asc(pmSchedules.nextDue));

  const fullTasks = taggedTasks.map((t) => ({
    ...t,
    createdAt: t.createdAt.toISOString(),
    completedAt: t.completedAt?.toISOString() ?? null,
    checklist: items.filter((c) => c.taskId === t.id).map((c) => ({
      ...c,
      thread: iNotes.filter((n) => n.itemId === c.id).map((n) => ({ ...n, createdAt: n.createdAt.toISOString() })),
    })),
    notes: tNotes.filter((n) => n.taskId === t.id).map((n) => ({ ...n, createdAt: n.createdAt.toISOString() })),
  }));

  const history = mergeAssetHistory(
    events.map((e) => ({ kind: e.kind, instrumentId: e.instrumentId, detail: e.detail, actor: e.actor, at: e.at })),
    taggedTasks.map((t) => ({ title: t.title, state: t.state, instrumentId: t.instrumentId, createdAt: t.createdAt, completedAt: t.completedAt })),
    taggedParts.map((p) => ({ name: p.name, status: p.status, instrumentId: p.instrumentId, createdAt: p.createdAt })),
    taggedTime.map((t) => ({ person: t.person, minutes: t.minutes, note: t.note, instrumentId: t.instrumentId, createdAt: t.createdAt })),
    formatHours,
  );

  return (
    <div className="container page">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <Link href="/assets" className="mut" style={{ fontSize: 13, textDecoration: "none" }}>
          ← Assets
        </Link>
        <span style={{ marginLeft: "auto" }} />
        {canEdit && <RunCheckoutButton assetId={asset.id} />}
        {isStaff && (
          <>
            <Link href={`/assets/${asset.id}/label`} className="btn sm" style={{ textDecoration: "none", flexShrink: 0 }}>
              Label
            </Link>
            <Link href={`/assets/${asset.id}/signoff`} className="btn sm" style={{ textDecoration: "none", flexShrink: 0 }}>
              Sign-off packet
            </Link>
          </>
        )}
      </div>

      <div className="card">
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: "var(--navy)" }}>
            {asset.kind} — {asset.model || "(no model)"}
          </div>
          {asset.forSale && <span className="pill" style={{ background: "#E5F3E5", color: "#2E6B2E" }}>For sale</span>}
        </div>
        <div className="mut" style={{ fontSize: 12, marginTop: 2 }}>
          {[asset.serial && `SN ${asset.serial}`, asset.manufacturer, asset.owner && `for ${asset.owner}`,
            asset.location && `@ ${asset.location}`].filter(Boolean).join(" · ") || "No identifiers yet."}
        </div>
        <div style={{ fontSize: 13, margin: "8px 0 10px" }}>
          {home ? (
            <>Currently in{" "}
              <Link href={`/instruments/${home.id}`} style={{ fontWeight: 700, textDecoration: "none" }}>
                {home.externalId} — {home.model}
              </Link>
            </>
          ) : (
            <span className="mut">{asset.status === "Decommissioned" ? "Retired - not attached to any system." : "Not attached to a system."}</span>
          )}
          {totalMinutes > 0 && <span className="mut"> · {formatHours(totalMinutes)} logged lifetime</span>}
        </div>
        {asset.asFound && (
          <div style={{ fontSize: 13, background: "#FAF0DC", border: "1px solid #F0C9A0", borderRadius: 8, padding: "7px 10px", marginBottom: 10 }}>
            <span className="eyebrow" style={{ color: "#8A5410" }}>As found</span>
            <div style={{ marginTop: 2, whiteSpace: "pre-wrap" }}>{asset.asFound}</div>
          </div>
        )}
        {asset.note && <div className="mut" style={{ fontSize: 13, marginBottom: 10, whiteSpace: "pre-wrap" }}>{asset.note}</div>}
        <AssetControls
          asset={{ id: asset.id, kind: asset.kind, model: asset.model, serial: asset.serial, manufacturer: asset.manufacturer, owner: asset.owner, asFound: asset.asFound, location: asset.location, note: asset.note, status: asset.status, instrumentId: asset.instrumentId }}
          systems={insts.filter((i) => !i.archived).map((i) => ({ id: i.id, externalId: i.externalId }))}
          owners={[...new Set([...ownerRows.map((o) => o.owner), ...insts.map((i) => i.client)].filter(Boolean))].sort()}
          kinds={vocab.filter((v) => v.kind === "asset_type").map((v) => v.name)}
          models={vocab.reduce<Record<string, string[]>>((acc, v) => {
            if (v.kind === "model" && v.assetType) (acc[v.assetType] ??= []).push(v.name);
            return acc;
          }, {})}
          canEdit={canEdit} isStaff={isStaff}
        />
        <GasPanel target={target} gases={gasRows.map((g) => ({ id: g.id, gas: g.gas, status: g.status, note: g.note }))}
          knownGases={[...new Set([...GASES, ...gasNames.map((g) => g.gas)])]} canEdit={canEdit} isStaff={isStaff} />
        <SharePanel target="asset" targetId={asset.id}
          shares={shareRows.map((r) => ({ orgId: r.orgId, name: r.name, kind: r.kind, access: r.access }))}
          orgOptions={orgRows} ownerOrgId={asset.ownerOrgId}
          canManageAll={isStaff} canAddProvider={!isStaff && canSell} />
        {canSell && (
          <SalePanel target="asset" targetId={asset.id} forSale={asset.forSale}
            saleNote={asset.saleNote} listingToken={asset.listingToken} />
        )}
      </div>

      <PartsPanel target={target} parts={redactParts(taggedParts, showCosts).map((p) => ({ ...p, createdAt: p.createdAt.toISOString() }))}
        systemAssets={[]} canEdit={canEdit} isStaff={isStaff} showCosts={showCosts} />

      <AttachmentsPanel target={target} attachments={attachRows.map(({ url: _url, ...a }) => ({ ...a, createdAt: a.createdAt.toISOString() }))}
        evidenceTasks={evidenceTasks}
        canEdit={canEdit} isStaff={isStaff} listingCuration={asset.forSale && canSell} />

      <TasksPanel target={target} tasks={fullTasks} people={peopleRows.map((p) => p.name)}
        systemAssets={[]} today={shopToday()} canEdit={canEdit} isStaff={isStaff} />

      <MaintenancePanel target={target} today={shopToday()} canEdit={canEdit}
        people={peopleRows.map((p) => p.name)}
        schedules={pmRows.map((s) => ({
          id: s.id, title: s.title, body: s.body, assignee: s.assignee,
          everyDays: s.everyDays, nextDue: s.nextDue, lastDone: s.lastDone, paused: s.paused,
          parts: schedulePartsOf(s),
          openTaskId: taggedTasks.find((t) => t.pmScheduleId === s.id && t.state !== "Done")?.id ?? null,
        }))} />

      {modules.eod && (isStaff || ownerIsViewer) && (
        <DailyUpdatePanel target={target}
          systemUpdate={todayUpdate?.systemUpdate ?? ""} actionItem={todayUpdate?.actionItem ?? ""}
          updatedBy={todayUpdate?.updatedBy ?? ""} canEdit={isStaff} />
      )}

      <div className="card">
        <div className="card-title" style={{ marginBottom: 4 }}>Service history</div>
        <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
          Lifecycle plus every task, part, and hour on this asset - its own work and anything tagged to it
          on a system, across every system it has lived in.
        </div>
        {history.map((h, i) => (
          <div key={i} style={{ display: "flex", gap: 8, padding: "7px 0", borderTop: "1px solid var(--line)", fontSize: 13, flexWrap: "wrap", alignItems: "baseline" }}>
            <span className="mut mono" style={{ fontSize: 11, flexShrink: 0, width: 108 }}>{shopTime(h.at)}</span>
            {h.instrumentId !== null && (label.get(h.instrumentId) ? (
              <Link href={`/instruments/${h.instrumentId}`} className="mono" style={{ fontSize: 11, fontWeight: 700, color: "var(--navy)", textDecoration: "none", flexShrink: 0 }}>
                {label.get(h.instrumentId)}
              </Link>
            ) : (
              // Work done while the unit lived somewhere the viewer can't see:
              // the event stays in the history, the system stays anonymous.
              <span className="mut mono" style={{ fontSize: 11, flexShrink: 0 }}>another system</span>
            ))}
            {KIND_LABEL[h.kind] && <span className="pill" style={{ background: "#EEF1F5", color: "#475569" }}>{KIND_LABEL[h.kind]}</span>}
            <span style={{ flex: 1, minWidth: 160 }}>
              {h.text}
              {h.detail && <span className="mut" style={{ fontSize: 12 }}> — {h.detail}</span>}
            </span>
          </div>
        ))}
        {history.length === 0 && <div className="mut" style={{ fontSize: 13 }}>No history yet.</div>}
      </div>

      <div className="card">
        <div className="card-title" style={{ marginBottom: 8 }}>Activity</div>
        {canEdit && <ActivityNoteForm target={target} />}
        <ActivityFeed items={activity.map((a) => ({
          id: a.id, actor: a.actor, action: a.action, field: a.field, newValue: a.newValue,
          when: shopTime(a.createdAt),
        }))} />
      </div>
    </div>
  );
}
