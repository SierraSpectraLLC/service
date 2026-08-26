import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import {
  appSettings, assets, attachments, auditLog, checklistItems, expenseCategories, instruments, itemNotes, orgs, orgSites, parts, poLines,
  purchaseOrders, taskNotes, tasks, timeEntries, vocabTerms, workOrders, workOrderNotes, expenses, agreements,
  rateCards, quotes,
} from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { assetAccess, assertSystemVisible, canEditSystem, forTenant, isHouse, readTenant } from "@/lib/tenancy";
import { getBrand } from "@/lib/brand";
import { visitFlag } from "@/lib/entitlementFlags";
import { canSeeCosts, redactParts } from "@/lib/redact";
import { systemPartiesFor } from "@/lib/partyData";
import { directoryNames, visibleDirectory } from "@/lib/directory";
import { formatHours } from "@/lib/hours";
import { formatCents } from "@/lib/money";
import { PO_LABEL, PO_TONE, poTotals } from "@/lib/po";
import { shopTime, shopToday } from "@/lib/shopday";
import { storeQuota } from "@/lib/storeUsage";
import { getSystemLabels, systemLabel } from "@/lib/systemLabel";
import {
  moverOf, severityOf, targetDay, woAcceptsWork, woLate, WO_LABEL, WO_TONE,
} from "@/lib/workOrders";
import ActivityFeed from "@/components/ActivityFeed";
import AttachmentsPanel from "@/components/AttachmentsPanel";
import HoursPanel from "@/components/HoursPanel";
import TasksPanel from "@/components/TasksPanel";
import WorkOrderControls from "@/components/WorkOrderControls";
import WorkOrderNotes from "@/components/WorkOrderNotes";
import PartsPanel from "@/components/PartsPanel";
import ExpensesPanel from "@/components/ExpensesPanel";
import { resolveExpensePolicy } from "@/lib/expensePolicy";
import { siteLabel } from "@/lib/sites";
import { tripMilesFor } from "@/lib/tripMiles";
import CreditHoldPanel from "@/components/CreditHoldPanel";
import CoveragePanel from "@/components/CoveragePanel";
import { coverageFor } from "@/lib/billing";
import { asStatementRow, billingContext, creditFor, invoicesForOrg } from "@/lib/invoiceData";
import { invoiceView, isOpen } from "@/lib/statement";
import { resolveRate } from "@/lib/rates";
import { quoteStanding, STANDING_LABEL as QUOTE_STANDING, STANDING_TONE as QUOTE_TONE } from "@/lib/quotes";
import QuoteJobButton from "@/components/QuoteJobButton";
import PhotosPanel from "@/components/PhotosPanel";
import { isPhotoFile } from "@/lib/photos";
import { procedures } from "@/db/schema";
import { coversSystem } from "@/lib/procedureRole";
import { scopeMatches } from "@/lib/checkout";
import { parseChecklist } from "@/lib/checklist";
import { loadTaskTests, testFieldsFor } from "@/lib/taskTests";
import { mentionableOn } from "@/lib/mentionAudience";
import PanelLayout from "@/components/PanelLayout";
import { HeroKebab, Id, Panel, Pill, RecordHero, type HeroStat } from "@/components/ui";
import { getUiLayout } from "@/app/actions";

export const dynamic = "force-dynamic";

/**
 * One job's own page: what was asked for, what is being done about it, and what
 * it cost.
 *
 * The tasks, hours and files panels are the same components the system page uses,
 * pointed at this order - so work filed here carries the order's id and appears
 * on both, and nobody has to learn a second way to log an hour. What is NOT here
 * is a second conversation: the discussion belongs to the system, which is where
 * the client is already looking, and splitting it would mean two places to check
 * for the same answer.
 */
export default async function WorkOrderPage({ params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { id } = await params;
  const woId = parseInt(id);
  if (isNaN(woId)) notFound();

  const [wo] = await db.select().from(workOrders).where(eq(workOrders.id, woId));
  if (!wo) notFound();

  // An order on a record you cannot see does not exist for you - the same
  // posture the system and asset pages take, checked against the record rather
  // than against the order, because the record is where access is decided.
  //
  // A job with no record behind it - a client's move, a survey, a call - has
  // no system to ask, so the order answers for itself: staff of the workspace
  // that owns it, or somebody at the client it was opened for. Same posture,
  // one rung further out.
  let inst: typeof instruments.$inferSelect | null = null;
  let asset: typeof assets.$inferSelect | null = null;
  let canEdit = false;
  if (wo.instrumentId !== null) {
    try { await assertSystemVisible(user, wo.instrumentId); } catch { notFound(); }
    [inst] = await db.select().from(instruments).where(eq(instruments.id, wo.instrumentId));
    canEdit = await canEditSystem(user, wo.instrumentId);
  } else if (wo.assetId) {
    const acc = await assetAccess(user, wo.assetId);
    if (!acc.see) notFound();
    [asset] = await db.select().from(assets).where(eq(assets.id, wo.assetId));
    canEdit = acc.edit;
  } else if (isHouse(user.role)) {
    const t = readTenant(user);
    if (t !== null && wo.tenantOrgId !== t) notFound();
    canEdit = true;
  } else {
    if (user.orgId === null || wo.orgId !== user.orgId) notFound();
    canEdit = user.role === "client_editor";
  }

  const staff = isHouse(user.role);
  const mover = moverOf(
    { isHouse: staff, orgId: user.orgId, houseOrgId: staff ? readTenant(user) : null },
    wo, inst?.ownerOrgId ?? asset?.ownerOrgId ?? null,
  );

  // The standing entitlement note on an OPEN job: recomputed, never stored, so
  // it appears the day the allowance runs dry and disappears if paper is added.
  // Staff only - the client's own view of their contract lives on their pages.
  const entFlag = staff && (wo.state === "open" || wo.state === "active" || wo.state === "waiting") && wo.orgId !== null
    ? await visitFlag(wo.orgId, wo.instrumentId).catch(() => "")
    : "";

  const [taskRows, timeRows, fileRows, people, askedByRows, brand, unitRows, noteRows, woPartRows, expenseRows, agreementRows, settingsForPolicy, siteRows, categoryRows, vocabRows] = await Promise.all([
    db.select().from(tasks).where(eq(tasks.workOrderId, woId))
      .orderBy(asc(tasks.sortOrder), asc(tasks.id)),
    db.select().from(timeEntries).where(eq(timeEntries.workOrderId, woId))
      .orderBy(desc(timeEntries.date), desc(timeEntries.id)),
    db.select().from(attachments).where(eq(attachments.workOrderId, woId))
      .orderBy(desc(attachments.createdAt)),
    visibleDirectory(user),
    wo.orgId === null ? Promise.resolve([]) : db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, wo.orgId)),
    getBrand(),
    wo.instrumentId === null ? Promise.resolve([]) : db.select().from(assets)
      .where(eq(assets.instrumentId, wo.instrumentId)).orderBy(asc(assets.sortOrder), asc(assets.id)),
    db.select().from(workOrderNotes).where(eq(workOrderNotes.workOrderId, woId))
      .orderBy(asc(workOrderNotes.createdAt), asc(workOrderNotes.id)),
    db.select().from(parts).where(eq(parts.workOrderId, woId))
      .orderBy(asc(parts.id)),
    db.select().from(expenses).where(eq(expenses.workOrderId, woId))
      .orderBy(desc(expenses.incurredOn), desc(expenses.id)),
    // What paper, if any, answers for this work: it decides whether an hour
    // logged here starts billable. lib/billing.coverageFor picks the paper;
    // lib/agreements still owns what a paper covers.
    wo.orgId === null ? Promise.resolve([]) : db.select().from(agreements).where(eq(agreements.orgId, wo.orgId)),
    // The travel rulebook the expense panel applies. One row, cached upstream.
    db.select().from(appSettings).where(eq(appSettings.id, 1)).then((r) => r[0]),
    // The client's labs, so the trip strip can name the destination and read
    // its miles instead of asking the engineer to remember them.
    wo.orgId === null ? Promise.resolve([]) : db.select().from(orgSites)
      .where(and(eq(orgSites.orgId, wo.orgId), eq(orgSites.archived, false)))
      .orderBy(asc(orgSites.name), asc(orgSites.id)),
    db.select().from(expenseCategories)
      .where(forTenant(expenseCategories.tenantOrgId, wo.tenantOrgId))
      .orderBy(asc(expenseCategories.sortOrder), asc(expenseCategories.id)),
    // The equipment catalog names the module types, so a part ordered here
    // says what it arrives as in the shop's own words.
    db.select({ kind: vocabTerms.kind, name: vocabTerms.name, assetType: vocabTerms.assetType, manufacturer: vocabTerms.manufacturer }).from(vocabTerms)
      .where(forTenant(vocabTerms.tenantOrgId, wo.tenantOrgId)),
  ]);

  const taskIds = taskRows.map((t) => t.id);
  const [items, tNotes, activity] = await Promise.all([
    taskIds.length ? db.select().from(checklistItems).where(inArray(checklistItems.taskId, taskIds))
      .orderBy(asc(checklistItems.sortOrder), asc(checklistItems.id)) : [],
    taskIds.length ? db.select().from(taskNotes).where(inArray(taskNotes.taskId, taskIds))
      .orderBy(asc(taskNotes.createdAt)) : [],
    db.select().from(auditLog)
      .where(and(eq(auditLog.entityType, "work_order"), eq(auditLog.entityId, String(woId))))
      .orderBy(desc(auditLog.createdAt)).limit(50),
  ]);
  const itemIds = items.map((i) => i.id);
  const iNotes = itemIds.length
    ? await db.select().from(itemNotes).where(inArray(itemNotes.itemId, itemIds)).orderBy(asc(itemNotes.createdAt))
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

  // What was bought for this job, and what it cost. Purchasing could never
  // answer "why did we buy this" before; this is the other end of that link,
  // and it is what makes a client's parts allowance defensible with a receipt.
  const poRows = await db.select().from(purchaseOrders)
    .where(eq(purchaseOrders.workOrderId, woId)).orderBy(desc(purchaseOrders.createdAt));
  const poLineRows = poRows.length
    ? await db.select().from(poLines).where(inArray(poLines.poId, poRows.map((p) => p.id)))
    : [];
  // Parts fitted on this job's system that came off one of those orders.
  const partRows = poRows.length && wo.instrumentId !== null
    ? await db.select().from(parts).where(and(
        eq(parts.instrumentId, wo.instrumentId),
        inArray(parts.poId, poRows.map((p) => p.id)),
      ))
    : [];
  // Prices follow the same rule as everywhere else: a partner from another
  // workspace works the job without seeing what the house paid for the parts.
  // Road miles from THIS person's home to each of the client's labs - cached,
  // so the network is only touched when something moved. Staff only: a trip
  // starts from an engineer's home, and clients do not have one on file.
  const routedMiles = staff
    ? await tripMilesFor(user.email, siteRows.map((x) => x.id)).catch(() => [])
    : [];

  const showCosts = canSeeCosts(user, inst?.ownerOrgId ?? asset?.ownerOrgId ?? null, wo.tenantOrgId);

  const today = shopToday();
  const sev = severityOf(wo.severity);
  const tone = WO_TONE[wo.state] ?? WO_TONE.open;
  const askedBy = wo.orgId === null ? brand.operatorName : askedByRows[0]?.name ?? "an organization";
  const minutes = timeRows.reduce((n, t) => n + t.minutes, 0);
  const coverage = coverageFor({
    agreements: agreementRows.map((a) => ({
      id: a.id, number: a.number, orgId: a.orgId, status: a.status,
      startsOn: a.startsOn, endsOn: a.endsOn, instrumentIds: a.instrumentIds,
      // Somebody else's contract cannot absorb our labour - see coverageFor.
      providerOrgId: a.providerOrgId,
      // A service contract carries the labor; parts pass through unless the
      // paper carries an allowance for them.
      laborCovered: a.kind === "contract",
      partsCovered: a.kind === "contract" && (a.partsUnlimited || a.partsAllowanceCents > 0),
    })),
    orgId: wo.orgId, instrumentId: wo.instrumentId, today,
  });
  // Where this client stands on credit, and what it would take to clear it.
  // Computed at render like everything else about money - there is no stored
  // hold flag to go stale after somebody pays.
  const credit = staff ? await creditFor(wo.orgId, today).catch(() => null) : null;
  const holdInvoices = credit && (credit.onHold || credit.override) && wo.orgId !== null
    ? (await invoicesForOrg(wo.orgId))
        .map((f) => ({ f, v: invoiceView(asStatementRow(f), today) }))
        .filter(({ v }) => isOpen(v))
        .sort((a, b) => b.v.daysLate - a.v.daysLate)
        .map(({ f, v }) => ({
          id: f.row.id, number: f.row.number, title: f.row.note || "",
          balanceCents: v.balanceCents, daysLate: v.daysLate,
        }))
    : [];
  const creditPolicy = credit && (credit.onHold || credit.override)
    ? (await billingContext(wo.orgId)).policy : null;

  // What this job bills at when it is not covered, and whether AP has a PO to
  // quote. Both are cheap questions before dispatch and expensive ones at day
  // forty-five.
  const rateCardRows = staff ? await db.select().from(rateCards) : [];
  const orgBilling = staff && wo.orgId !== null
    ? await db.select().from(orgs).where(eq(orgs.id, wo.orgId)).then((r) => r[0] ?? null)
    : null;
  const rate = resolveRate(rateCardRows, { orgId: wo.orgId, agreementId: coverage.agreementId });
  const quoteRows = staff
    ? await db.select().from(quotes).where(eq(quotes.workOrderId, woId)).orderBy(desc(quotes.id))
    : [];

  // A job with no record could turn out to be about one - offered only while
  // it is still taking work, and only the systems that could honestly take it:
  // this client's own, plus the shop's own bench.
  const adoptableRows = !inst && !asset && staff && woAcceptsWork(wo.state)
    ? await db.select({
        id: instruments.id, externalId: instruments.externalId, model: instruments.model,
        ownerOrgId: instruments.ownerOrgId,
      }).from(instruments)
        .where(and(
          eq(instruments.archived, false),
          forTenant(instruments.tenantOrgId, wo.tenantOrgId),
          wo.orgId === null ? undefined : or(eq(instruments.ownerOrgId, wo.orgId), isNull(instruments.ownerOrgId)),
        ))
        .orderBy(asc(instruments.externalId))
    : [];
  const adoptableLabels = await getSystemLabels(adoptableRows);
  const adoptable = adoptableRows.map((r) => ({
    id: r.id, externalId: r.externalId, label: adoptableLabels.get(r.id) ?? r.model,
  }));

  // Where the job lives. With no record it is the client's own page - which is
  // the honest answer to "where is this job", and the page that holds the rest
  // of their work.
  const place = inst
    ? { href: `/instruments/${inst.id}`, label: `${inst.externalId}${systemLabel(inst, unitRows) ? ` - ${systemLabel(inst, unitRows)}` : ""}` }
    : asset
      ? { href: `/assets/${asset.id}`, label: `${asset.kind}${asset.model ? ` - ${asset.model}` : ""}${asset.serial ? ` (SN ${asset.serial})` : ""}` }
      : wo.orgId !== null && staff
        ? { href: `/settings/organizations/${wo.orgId}`, label: askedBy }
        : { href: "", label: "" };

  // Work is filed against the ORDER, which resolveTarget then checks belongs to
  // this record - so the panels below write rows that show up in both places.
  // A settled order takes no new work, so they go read-only rather than
  // offering a form that will refuse.
  const target = {
    instrumentId: wo.instrumentId, assetId: wo.instrumentId === null ? wo.assetId : null,
    workOrderId: wo.id,
  };
  const canAdd = canEdit && woAcceptsWork(wo.state);
  // Catalog procedures that apply to whatever this job is on, offered as
  // starting points for a task. Same coverage rules the PM generator uses:
  // system procedures scoped by category, module procedures by unit kind and
  // model - so "Leak test" appears on an LC job and not on a TOC's.
  const procRows = canAdd
    ? await db.select().from(procedures).where(forTenant(procedures.tenantOrgId, readTenant(user)))
    : [];
  const procedureChoices = procRows
    .filter((pr) => {
      if (inst) {
        if (pr.assetType === "system") return coversSystem(pr.categoryScope, inst.category);
        return unitRows.some((a) => a.kind === pr.assetType
          && (pr.modelScope.length === 0 || scopeMatches(pr.modelScope, a.model)));
      }
      // A job on nothing has no unit to match a procedure against.
      if (!asset) return false;
      return pr.assetType === asset.kind
        && (pr.modelScope.length === 0 || scopeMatches(pr.modelScope, asset.model));
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((pr) => {
      const steps = parseChecklist(pr.checklist).filter((l) => !l.heading).length;
      const brings = [
        steps ? `brings a ${steps}-step checklist` : "",
        pr.kind === "test" ? `${pr.resultType === "pass_fail" ? "pass/fail" : pr.resultType} result required` : "",
      ].filter(Boolean).join(" · ");
      return { id: pr.id, title: pr.name, body: pr.notes, brings };
    });

  // Files alone stay writable on a settled order, house staff only: the
  // signed report arrives weeks after the job is filed, and reopening a
  // closed job to carry one PDF pollutes its state history. The server
  // enforces the same rule (resolveTarget's lateFiles), so this widening is
  // display, not authority.
  const canAttach = canAdd || (canEdit && staff);
  const fileQuota = await storeQuota(inst?.ownerOrgId ?? asset?.ownerOrgId ?? null, inst?.tenantOrgId ?? asset?.tenantOrgId ?? null);

  // Who the composer may offer for an @mention: this record's readers, and
  // nobody else - see lib/mentionAudience.
  const mentionable = await mentionableOn(people, {
    instrumentId: wo.instrumentId, assetId: wo.assetId,
    orgId: wo.orgId, tenantOrgId: wo.tenantOrgId,
  });

  const panelLayout = await getUiLayout("workorder");
  const openTasksH = taskRows.filter((t) => t.state !== "Done").length;
  const heroStats: HeroStat[] = [
    { value: WO_LABEL[wo.state] ?? wo.state, label: "", tone: tone === "neutral" ? undefined : tone },
    { value: sev.label, label: "" },
    ...(woLate(wo, today) ? [{ value: `wanted by ${targetDay(wo.severity, wo.openedOn)}`, label: "", tone: "bad" as const }] : []),
    ...(openTasksH ? [{ value: openTasksH, label: `open task${openTasksH === 1 ? "" : "s"}` }] : []),
    ...(minutes ? [{ value: formatHours(minutes), label: "logged" }] : []),
  ];

  return (
    <div className="container page">
      <div className="crumb">
        <Link href="/work" style={{ textDecoration: "none", color: "inherit" }}>Work orders</Link> › <b>{wo.number}</b>
      </div>

      <RecordHero
        eyebrow={<>Asked by {askedBy}{wo.requestedBy ? ` · ${wo.requestedBy}` : ""}</>}
        id={wo.number}
        title={wo.title}
        meta={`opened ${wo.openedOn}${wo.assignee ? ` · with ${wo.assignee}` : " · nobody assigned"}`}
        stats={heroStats}
        actions={
          <>
            {staff && canAdd && wo.orgId !== null && quoteRows.length === 0 && (
              <QuoteJobButton workOrderId={wo.id} number={wo.number} title={wo.title} today={today} />
            )}
            {place.href && (
              <Link href={place.href} className="btn sm" style={{ textDecoration: "none" }}>
                {place.label} →
              </Link>
            )}
          </>
        }
        kebab={<HeroKebab arrange menuLabel={`Actions for ${wo.number}`} />}
      />

      {/* Before the job itself, because the moment that matters is the one
          where somebody is deciding whether to load the van. */}
      {credit && creditPolicy && wo.orgId !== null && (
        <CreditHoldPanel
          standing={credit}
          invoices={holdInvoices}
          policy={creditPolicy}
          orgId={wo.orgId}
          orgName={askedBy}
          canOverride={user.role === "owner"}
        />
      )}

      {staff && quoteRows.length > 0 && (
        <Panel title="Quotes" count={quoteRows.length}>
          {quoteRows.map((q) => (
            <div key={q.id} className="row-2" style={{ alignItems: "baseline", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
              <Link href={`/money/quotes/${q.id}`} className="t-body" style={{ textDecoration: "none", fontWeight: 600 }}>
                <Id>{q.number}</Id>
              </Link>
              <span className="mut t-small" style={{ flex: 1, minWidth: 0 }}>{q.title}</span>
              <Pill tone={QUOTE_TONE[quoteStanding(q, today)]}>{QUOTE_STANDING[quoteStanding(q, today)]}</Pill>
            </div>
          ))}
        </Panel>
      )}

      {staff && (
        <CoveragePanel
          coverage={coverage}
          rateCents={coverage.labor && !coverage.exhausted ? 0 : rate.hourlyCents}
          poNumber={orgBilling?.poNumber ?? ""}
          orgName={askedBy}
        />
      )}

      <PanelLayout
        viewKey="workorder"
        saved={panelLayout}
        defaultRight={[]}
        pinned={["job"]}
        groups={[
          { key: "work", label: "Work", keys: ["notes", "tasks", "parts", "hours"],
            badge: openTasksH || undefined,
            badgeTone: taskRows.some((t) => t.state !== "Done" && t.dueDate && t.dueDate < today) ? "bad" : "info" },
          { key: "files", label: "Files", keys: ["files", "photos"] },
          { key: "purchasing", label: "Purchasing", keys: ["po"] },
          { key: "history", label: "History", keys: ["activity"] },
        ]}
        panels={[
          { key: "job", label: "The job", node: (
      <div className="card">
        {entFlag && (
          <div className="t-small" style={{ padding: "8px 10px", borderRadius: 8, background: "#FAF0DC", color: "var(--t-warn-fg)", marginTop: 10 }}>
            {entFlag}
          </div>
        )}

        {wo.body && (
          <div className="t-body" style={{ whiteSpace: "pre-wrap", borderLeft: "3px solid var(--line)", padding: "4px 10px", margin: "10px 0" }}>
            {wo.body}
          </div>
        )}

        {wo.closeSummary && (
          <div style={{ marginTop: 10, background: "#F6FAF6", borderLeft: "3px solid #2E6B2E", padding: "8px 10px" }}>
            <div className="eyebrow" style={{ marginBottom: 2 }}>What was done</div>
            <div className="t-body" style={{ whiteSpace: "pre-wrap" }}>{wo.closeSummary}</div>
            {wo.closedBy && <div className="mut t-meta" style={{ marginTop: 4 }}>Closed by {wo.closedBy}</div>}
          </div>
        )}

        <WorkOrderControls
          id={wo.id} number={wo.number} state={wo.state} mover={mover}
          title={wo.title} body={wo.body} severity={wo.severity} assignee={wo.assignee}
          people={directoryNames(people)}
          systems={adoptable}
        />
      </div>
          ) },
          { key: "notes", label: "Notes", node: (
      <WorkOrderNotes workOrderId={wo.id} canPost={canEdit} people={mentionable}
        me={{ email: user.email, name: user.name, isHouse: staff }}
        notes={noteRows.map((n) => ({
          id: n.id, author: n.author, authorEmail: n.authorEmail, text: n.text,
          createdAt: n.createdAt.toISOString(), editedAt: n.editedAt?.toISOString() ?? null,
        }))} />
          ) },
          { key: "tasks", label: "Tasks", node: (
      <TasksPanel target={target} tasks={fullTasks} people={directoryNames(people)} mentionable={mentionable}
        systemAssets={unitRows.map((a) => ({ id: a.id, label: `${a.kind} - ${a.model || a.serial || "?"}` }))}
        today={today} canEdit={canAdd} isStaff={staff} copyTargets={[]}
        procedureChoices={procedureChoices} />
          ) },
          ...((canAdd || woPartRows.length > 0) ? [{ key: "parts", label: "Parts", node: (
          <>
      {/* The job's own parts list - what this repair looks like needing, and
          then what it took. Rows carry the work order, so they read here and
          on the system's full parts panel alike; "potential" is just status
          Needed, the same word the rest of the shop already uses. */}
      {(canAdd || woPartRows.length > 0) && (
        <PartsPanel target={target}
          parts={redactParts(woPartRows, user, inst?.ownerOrgId ?? asset?.ownerOrgId ?? null, wo.tenantOrgId)
            .map((pp) => ({ ...pp, createdAt: pp.createdAt.toISOString() }))}
          systemAssets={unitRows.map((a) => ({ id: a.id, label: `${a.kind} - ${a.model || a.serial || "?"}` }))}
          canEdit={canAdd} isStaff={staff}
          moduleTypes={vocabRows.filter((v) => v.kind === "asset_type").map((v) => v.name)}
          moduleModels={vocabRows.filter((v) => v.kind === "model")
            .map((v) => ({ assetType: v.assetType, name: v.name, manufacturer: v.manufacturer }))}
          showCosts={canSeeCosts(user, inst?.ownerOrgId ?? asset?.ownerOrgId ?? null, wo.tenantOrgId)}
          /* A job on a system offers that system's parties; a client's move or
             survey has no system behind it and so no picker. */
          makers={inst ? await systemPartiesFor(inst.id, user.orgId) : []} />
      )}
      <ExpensesPanel workOrderId={wo.id} today={today} canEdit={canAdd} isStaff={staff}
        policy={resolveExpensePolicy(settingsForPolicy?.expensePolicy ?? null)}
        sites={siteRows.map((x) => {
          const routed = routedMiles.find((r) => r.siteId === x.id);
          return {
            id: x.id, name: siteLabel(x), onewayMiles: x.onewayMiles,
            routedMiles: routed?.miles ?? null, routedEstimated: routed?.estimated ?? false,
          };
        })}
        defaultSiteId={inst?.siteId ?? null}
        categories={categoryRows.map((c) => c.name)}
        rows={expenseRows.map((e) => ({
          id: e.id, kind: e.kind, description: e.description,
          amountCents: e.amountCents, incurredOn: e.incurredOn, billable: e.billable,
        }))} />
          </>
          ) }] : []),
          { key: "hours", label: "Hours", node: (
      <HoursPanel target={target}
        entries={timeRows.map((t) => ({ id: t.id, person: t.person, date: t.date, minutes: t.minutes, note: t.note, billable: t.billable, category: t.category }))}
        people={directoryNames(people)} defaultPerson={user.name}
        today={today} canEdit={canAdd} isStaff={staff}
        defaultBillable={!coverage.labor} coveredBy={coverage.agreementNumber} />
          ) },
          { key: "files", label: "Files", node: (
      <AttachmentsPanel target={target} today={shopToday()}
        attachments={fileRows.map(({ url: _url, ...a }) => ({ ...a, createdAt: a.createdAt.toISOString() }))}
        evidenceTasks={taskRows.map((t) => ({ id: t.id, title: t.title, required: false }))}
        canEdit={canAttach} isStaff={staff} listingCuration={false} storage={fileQuota}
        combineTitle={`${wo.number} packet`}
        combineLines={[wo.title, place.label, `Prepared by ${user.name}`].filter(Boolean)} />
          ) },
          ...((canAttach || fileRows.some(isPhotoFile)) ? [{ key: "photos", label: "Photos", node: (
          <>
      {/* The job's pictures - the error dialog, the scored seal, the bench
          after. Same panel the system page has; uploads land tagged with both
          the system and the job, so they read in either gallery. No cover
          here: a job is an event, not a thing with a face. */}
      {(canAttach || fileRows.some(isPhotoFile)) && (
        <PhotosPanel target={target} coverId={null}
          photos={fileRows.filter(isPhotoFile).map((a) => ({
            id: a.id, fileName: a.fileName, kind: a.kind, framing: a.framing,
            uploadedBy: a.uploadedBy, when: shopTime(a.createdAt), createdAt: a.createdAt.toISOString(),
          }))}
          label={`${wo.number} - ${wo.title}`}
          canEdit={canAttach} storageFull={fileQuota.state === "full"} />
      )}
          </>
          ) }] : []),
          ...(poRows.length > 0 ? [{ key: "po", label: "Bought for this job", node: (
        <div className="card">
          <div className="card-title">Bought for this job</div>
          {poRows.map((p) => {
            const mine = poLineRows.filter((l) => l.poId === p.id);
            const t = poTotals(mine);
            const receipts = fileRows.filter((f) => f.poId === p.id);
            return (
              <div key={p.id} style={{
                display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap",
                padding: "8px 4px", borderTop: "1px solid var(--line)",
              }}>
                <Link href={`/money/purchasing/${p.id}`} className="mono t-small"
                  style={{ fontWeight: 700, color: "var(--navy)", textDecoration: "none" }}>
                  {p.number}
                </Link>
                <span className="t-body">{p.vendor}</span>
                <span className={`pill ${PO_TONE[p.status] ?? "neutral"}`}>
                  {PO_LABEL[p.status] ?? p.status}
                </span>
                <span className="mut t-meta">
                  {t.received}/{t.ordered} received
                  {receipts.length ? ` · ${receipts.length} receipt${receipts.length === 1 ? "" : "s"} on file` : ""}
                </span>
                {showCosts && t.cents > 0 && (
                  <span className="mono t-meta" style={{ marginLeft: "auto", color: "var(--slate)" }}>
                    {formatCents(t.cents)}{t.unpriced ? ` +${t.unpriced} unpriced` : ""}
                  </span>
                )}
              </div>
            );
          })}
          {partRows.length > 0 && (
            <div className="mut" style={{ fontSize: 12, marginTop: 8 }}>
              {partRows.length} part{partRows.length === 1 ? "" : "s"} from these orders {partRows.length === 1 ? "is" : "are"} on
              the system&apos;s parts list, where the client&apos;s allowance reads them.
            </div>
          )}
        </div>
          ) }] : []),
          ...(activity.length > 0 ? [{ key: "activity", label: "History", node: (
        <div className="card">
          <div className="card-title">History</div>
          <ActivityFeed items={activity.map((a) => ({
            id: a.id, actor: a.actor, action: a.action, field: a.field, newValue: a.newValue,
            when: shopTime(a.createdAt),
          }))} />
        </div>
          ) }] : []),
        ]}
      />
    </div>
  );
}
