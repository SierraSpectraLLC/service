import type { Metadata } from "next";
import { and, asc, eq, desc, inArray, isNull, lte, ne, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "@/db";
import Link from "next/link";
import { clientAllowlist, instruments, instrumentGases, parts, auditLog, sheetDiffs, tasks, assets, vocabTerms, engagementRecords, orgs, orgSites, attachments, workOrders, users, pmSchedules, agreements } from "@/db/schema";
import { coverageOf, coverageSummary, type CoverageAgreement } from "@/lib/coverage";
import { dayOf, lastVisitBy, visitsOf, visitsThisYear, type Completion } from "@/lib/serviceHistory";
import { daysSince, queueView } from "@/lib/queue";
import { brandForTenant, getBrand } from "@/lib/brand";
import { getModules } from "@/lib/flags";
import { shopMonthDay, shopTime } from "@/lib/shopday";
import { BLOCKED_STAGE, GAS_SYMBOL, gasAttention, partOpen, assetAttention } from "@/lib/stages";
import { expiryAttention, expiryLabel } from "@/lib/gxp";
import { getStageDefs } from "@/lib/stageDefs";
import { systemLabel } from "@/lib/systemLabel";
import { shopToday } from "@/lib/shopday";
import { directoryNames, visibleDirectory } from "@/lib/directory";
import { currentUser, requireUser, viewContext } from "@/lib/authz";
import { forTenant, maySeeAgreements, maySeeOrgMoney, readTenant, viewTenant, visibleOrgs, visibleSystemIds } from "@/lib/tenancy";
import { notHeld, fleetHold } from "@/lib/fleetHold";
import { clientOptions } from "@/lib/clientNames";
import { shelveRecords } from "@/lib/records";
import { severityOf, woOpen } from "@/lib/workOrders";
import { redirect } from "next/navigation";
import Dashboard from "@/components/Dashboard";
import Landing from "@/components/Landing";
import { EMPTY_LIBRARY, landingLibrary } from "@/lib/landingData";
import { getAppearance } from "@/lib/appearanceData";
import { appUrl } from "@/lib/appUrl";
import ClientLanding, { type ClientSystem } from "@/components/ClientLanding";
import { clientTodos, pipelineFor, readyToMove, stateOf, whySentence } from "@/lib/clientLandingData";
import { rankTodos } from "@/lib/clientView";
import ResellerLanding from "@/components/ResellerLanding";
import { PageHead } from "@/components/ui";
import ClientCoverage from "@/components/ClientCoverage";
import MoneyCard from "@/components/MoneyCard";
import { seesBooksFor } from "@/lib/financeData";
import { availableViews, mayChooseView, viewModeFor } from "@/lib/viewMode";
import ViewTour from "@/components/ViewTour";

export const dynamic = "force-dynamic";

/**
 * Two pages, one address, and so two sets of metadata.
 *
 * Signed in this route is the board, and the layout's generic title is right
 * for it - a tab among twenty other tabs of the same app. Signed out it is
 * the ONE page on this instance a crawler is allowed to index (see robots.ts,
 * where `/$` is the whole allowlist besides the library), and it was
 * inheriting "Instrument management" / "Instrument refurbishment tracking"
 * from the layout: a description written for a browser tab, serving as the
 * search result for the site's front door.
 *
 * currentUser() and getBrand() are both cache()d and the page calls them
 * again a few lines down, so this costs no extra round trip.
 */
export async function generateMetadata(): Promise<Metadata> {
  const [visitor, brand] = await Promise.all([currentUser(), getBrand()]);
  if (visitor) return {};        // inherit the layout's app title
  const url = appUrl();
  const title = `${brand.name} - instrument service, on the record`;
  const description =
    "One record per machine - its modules, its serials, the work done on it and the "
    + "parts that went in - shared with the people who own it. Instrument service "
    + "management for laboratories and the companies that keep them running.";
  return {
    title,
    description,
    alternates: url ? { canonical: url } : undefined,
    robots: { index: true, follow: true },
    // A link to this page gets pasted into Slack and email far more often than
    // it gets typed, and an unfurl with no card is a link nobody clicks.
    openGraph: {
      title, description, siteName: brand.name, type: "website",
      ...(url ? { url } : {}),
    },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default async function Home({ searchParams }: {
  searchParams: Promise<{ q?: string; f?: string; sort?: string; where?: string }>;
}) {
  const initial = await searchParams;
  // The apex answers strangers now, so a missing session is not an error here
  // - it is the other half of this route. Bouncing to /login would have made
  // the front door of the site a sign-in form.
  const visitor = await currentUser();
  if (!visitor) {
    const [brand, modules, look] = await Promise.all([getBrand(), getModules(), getAppearance()]);
    // Only read the catalog when the module is on: an instance with the public
    // library switched off must not pay for a scan of vocab_terms on every
    // anonymous hit to its front door.
    const library = modules.publicCatalog ? await landingLibrary() : EMPTY_LIBRARY;
    return <Landing brandName={brand.name} operatorName={brand.operatorName}
      tagline={brand.tagline} catalogOn={modules.publicCatalog}
      contactEmail={brand.contactEmail} headerColor={look.headerColor} library={library} />;
  }
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }

  // Staff see the whole shop; an organization sees only what's shared with it.
  // `null` means no restriction - an empty list means nothing, so every query
  // below must go through `mine()`.
  const visible = await visibleSystemIds(user);
  const mine = (col: AnyColumn): SQL | undefined =>
    visible === null ? undefined : visible.length ? inArray(col, visible) : sql`false`;

  const heldBack = await fleetHold(readTenant(user));
  const [rows, allParts, allGases, recent, openRowDiffs, stageDefList, peopleRows, taskRows, assetRows, allSystems, vocabCats] = await Promise.all([
    /* Not a prospect's. Quoting a company means creating its systems, and
       without this one quote puts a stranger's machines on the board - see
       lib/fleetHold. */
    db.select().from(instruments)
      .where(and(eq(instruments.archived, false), mine(instruments.id), notHeld(instruments.id, heldBack.systems)))
      .orderBy(asc(instruments.priority), asc(instruments.externalId)),
    db.select().from(parts).where(mine(parts.instrumentId)),
    db.select().from(instrumentGases).where(mine(instrumentGases.instrumentId)),
    // The activity log is the shop's working memory, and it is deliberately
    // not a client panel (see lib/clientView). Staff only, for the same reason
    // - and a client page load stops paying for 200 rows it never showed.
    user.role === "owner" || user.role === "staff"
      ? db.select().from(auditLog).where(mine(auditLog.instrumentId)).orderBy(desc(auditLog.createdAt)).limit(200)
      : Promise.resolve([]),
    // Sheet parity is an internal reconciliation, and this is the one query on
    // the page with neither mine() nor a tenant filter. Its result was thrown
    // away for non-staff at the point of use, which meant every client page
    // load paid for a scan of everybody's diffs to compute nothing.
    user.role === "owner" || user.role === "staff"
      ? db.select().from(sheetDiffs).where(and(eq(sheetDiffs.resolved, false), eq(sheetDiffs.field, "Row")))
      : Promise.resolve([]),
    getStageDefs(await viewTenant(user)),
    // Who work can be assigned to: the logins of the organizations this viewer
    // works with. See lib/directory.
    visibleDirectory(user),
    // completedAt and origin ride along for the client's service history: a PM
    // recorded as done files a Done TASK and never a work order, so counting
    // only closed work orders reported real visits as none. See lib/serviceHistory.
    db.select({ instrumentId: tasks.instrumentId, assetId: tasks.assetId, dueDate: tasks.dueDate, state: tasks.state, assignee: tasks.assignee, title: tasks.title, completedAt: tasks.completedAt, origin: tasks.origin }).from(tasks).where(mine(tasks.instrumentId)),
    db.select({ instrumentId: assets.instrumentId, kind: assets.kind, model: assets.model, serial: assets.serial, manufacturer: assets.manufacturer, status: assets.status, sortOrder: assets.sortOrder }).from(assets).where(mine(assets.instrumentId)),
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
    // For the client's "visits this year" - one more column on a query the
    // board already runs, rather than a second pass over the same table.
    closedAt: workOrders.closedAt,
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
    // The viewer's workspace, not the instance's. getBrand() names the company
    // that RUNS the instance, so on a second workspace every "us" badge, every
    // "waiting on you" line and the coverage panel read out the landlord's
    // company name. viewTenant is the right one here because a client reads
    // their own operator's name, which is exactly who they are waiting on.
    brandForTenant(await viewTenant(user)),
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
  const seesBooks = isStaff && await seesBooksFor(user);
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

  // What makes a SYSTEM mine: I lead it, or work on it is assigned to me.
  // System-level rather than item-level on purpose - a day is planned by which
  // instruments you are touching, and the system page is where the tasks, the
  // orders, the parts and the history already live. Matching by the signed-in
  // name, the same string assignment writes.
  const meName = (user.name || "").trim().toLowerCase();
  const isMine = (x: string) => !!meName && x.trim().toLowerCase() === meName;
  const myWoBySys = new Map<number, typeof openWos>();
  for (const w of openWos) {
    if (w.instrumentId === null || !isMine(w.assignee)) continue;
    myWoBySys.set(w.instrumentId, [...(myWoBySys.get(w.instrumentId) ?? []), w]);
  }
  const myTaskBySys = new Map<number, { overdue: number; total: number }>();
  for (const t of taskRows) {
    if (t.instrumentId === null || t.state === "Done" || !isMine(t.assignee)) continue;
    const at = myTaskBySys.get(t.instrumentId) ?? { overdue: 0, total: 0 };
    at.total++;
    if (t.dueDate && t.dueDate < today) at.overdue++;
    myTaskBySys.set(t.instrumentId, at);
  }

  /** "DOWN · WO-1002" / "2 tasks · 1 overdue" / "you're the lead" - why it's mine. */
  const mineNoteFor = (i: { id: number; lead: string }) => {
    const wos = myWoBySys.get(i.id) ?? [];
    const tasks = myTaskBySys.get(i.id);
    const bits: string[] = [];
    const worst = [...wos].sort((a, b) => severityOf(a.severity).rank - severityOf(b.severity).rank)[0];
    if (worst) bits.push(`${wos.length > 1 ? `${wos.length} jobs · ` : ""}${worst.number}`);
    if (tasks) bits.push(`${tasks.total} task${tasks.total === 1 ? "" : "s"}${tasks.overdue ? ` · ${tasks.overdue} overdue` : ""}`);
    if (!bits.length && isMine(i.lead)) bits.push("you're the lead");
    return bits.join(" · ");
  };

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
      // Whose problem a block is - chosen when it was set, null being ours.
      // The client landing reads it to tell "parked on them" from "parked on
      // us", which used to be the same amber banner. See queueNeedsThem.
      blockedOrgId: i.blockedOrgId,
      notes: i.notes,
      openParts,
      gasIssues,
      docIssues,
      overdue: overdueBy.get(i.id) ?? 0,
      assetIssues: assetRows
        .filter((a) => a.instrumentId === i.id && assetAttention(a.status))
        .map((a) => `${a.kind.toLowerCase()} ${a.status === "Down" ? "down" : "attn"}`),
      missingFromSheet: droppedFromSheet.has(i.externalId),
      // Blocked is the one stage that MEANS something is wrong: it is the only
      // one that demands a written reason, and a system sitting in it is a
      // system nobody is moving. The board has to say so, with the age -
      // "blocked" and "blocked 40d" are different problems.
      blockedDays: i.stages.includes(BLOCKED_STAGE)
        ? (i.blockedSince ? daysSince(i.blockedSince, new Date()) : 0)
        : null,
      lastActivity: last ? `${last.action} - ${last.actor.split("@")[0]}` : "",
      // Whose move it is. A system parked with the client is still visible -
      // hiding it would just move the forgetting somewhere else - but it reads
      // as theirs, and the "Ours to move" filter takes it off the board.
      down: downByWo.has(i.id) || assetRows.some((a) => a.instrumentId === i.id && a.status === "Down"),
      // What its modules are, so searching a serial or a model finds the
      // SYSTEM it sits on - which is how somebody with a part number in hand
      // actually looks for a machine. Kept as separate strings so a query can
      // never match across the join between two unrelated units.
      assetText: assetRows.filter((a) => a.instrumentId === i.id)
        .map((a) => [a.kind, a.manufacturer, a.model, a.serial].filter(Boolean).join(" ")),
      mine: myWoBySys.has(i.id) || myTaskBySys.has(i.id) || isMine(i.lead),
      mineNote: mineNoteFor(i),
      queueMine: queueView(user, i) === "mine",
      queueWith: queueName(i.queueOrgId),
      queueReason: i.queueReason,
    };
  });

  /* ── Which shape this client reads ──────────────────────────────────────
     Resolved BEFORE the landing is built, because "board" opts out of the
     landing entirely: the person falls through to the operator's own table
     below, on exactly the rows tenancy already scoped for them. Three answers,
     closest first - their own choice, the starting view their operator set,
     their company's default - same rule the nav reads. See lib/viewMode. */
  const orgSelf = user.orgId !== null ? orgNames.find((o) => o.id === user.orgId) : undefined;
  const [meRow] = !isStaff && user.orgId !== null
    ? await db.select({ viewMode: users.viewMode, viewTourAt: users.viewTourAt })
        .from(users).where(eq(users.email, user.email.toLowerCase())).catch(() => [])
    : [];
  const [startRow] = !isStaff && user.orgId !== null
    ? await db.select({ startView: clientAllowlist.startView })
        .from(clientAllowlist).where(eq(clientAllowlist.entry, user.email.toLowerCase())).catch(() => [])
    : [];
  const clientMode = !isStaff && user.orgId !== null
    ? viewModeFor(meRow?.viewMode ?? "", startRow?.startView ?? "", orgSelf?.resaleEnabled ?? false)
    : null;
  /* Said once, on the page they land on: which view they are in and where
     the switch is. The account menu is the right home for a personal setting
     and the wrong place to discover one - somebody started in a view by
     their operator has no reason to suspect there is another. */
  const tour = clientMode !== null && mayChooseView(orgSelf?.resaleEnabled ?? false) && !meRow?.viewTourAt
    ? <ViewTour
        mode={clientMode}
        others={availableViews(orgSelf?.resaleEnabled ?? false).filter((m) => m !== clientMode)}
        assigned={(startRow?.startView ?? "") !== "" && (meRow?.viewMode ?? "") === ""} />
    : null;

  /* ── The client's own product ──────────────────────────────────────────
     Everything below runs only for a non-staff viewer, and only for one who
     belongs to an organization - and not for one reading the board, whose
     page is the shared table at the bottom of this file. Staff pay nothing
     for it; a client stops paying for the parts of the board that were never
     theirs. */
  if (!isStaff && user.orgId !== null && clientMode !== "board") {
    const pmDueRows = rows.length
      ? await db.select({ instrumentId: pmSchedules.instrumentId, nextDue: pmSchedules.nextDue })
          .from(pmSchedules)
          .where(and(
            inArray(pmSchedules.instrumentId, rows.map((r) => r.id)),
            eq(pmSchedules.paused, false),
            lte(pmSchedules.nextDue, today),
          ))
          .orderBy(asc(pmSchedules.nextDue))
      : [];
    /* Where each instrument is. A named site when the account has one - the
       word a manager at Hayward uses - and the room or bench otherwise. One
       field with one meaning, because the card shows it and the grouping
       reads it, and two would eventually disagree. */
    const siteIds = [...new Set(rows.map((r) => r.siteId).filter((x): x is number => x !== null))];
    const siteRows = siteIds.length
      ? await db.select({ id: orgSites.id, name: orgSites.name }).from(orgSites)
          .where(inArray(orgSites.id, siteIds)).catch(() => [])
      : [];
    const siteName = new Map(siteRows.map((x) => [x.id, x.name]));

    /* A VISIT IS A DAY SOMEBODY COMPLETED WORK ON THE SYSTEM - from whichever
       table recorded it. This used to read closed work orders alone, which is
       a fact about filing rather than about service: a PM recorded as done
       files a Done TASK and never a work order (see actions.alignMaintenance),
       so a shop that ran a client's annual PM the way the maintenance panel
       invites you to had it counted as no visit at all.

       Still nothing inferred: a completion is a row somebody wrote saying work
       finished, never an audit line, which would count a field edit as an
       engineer standing in the room. See lib/serviceHistory. */
    const completions: Completion[] = [
      ...woRows.flatMap((w) => (w.instrumentId === null || w.closedAt === null ? [] : [{
        instrumentId: w.instrumentId,
        day: dayOf(w.closedAt),
        planned: w.severity === "Planned",
      }])),
      ...taskRows.flatMap((t) => (
        t.instrumentId === null || t.state !== "Done" || t.completedAt === null
          || (t.origin !== "pm" && t.origin !== "pm_request")
          ? []
          : [{ instrumentId: t.instrumentId, day: dayOf(t.completedAt), planned: true }]
      )),
    ];
    const visits = visitsOf(completions);
    const lastVisitBySys = new Map([...lastVisitBy(visits)]
      .map(([id, day]) => [id, shopMonthDay(new Date(`${day}T12:00:00Z`))] as const));

    const pmBySys = new Map<number, string>();
    for (const p of pmDueRows) {
      if (p.instrumentId !== null && !pmBySys.has(p.instrumentId)) pmBySys.set(p.instrumentId, p.nextDue);
    }

    // The worst open job per system, for the sentence under the card.
    const woBySys = new Map<number, typeof openWos>();
    for (const w of openWos) {
      if (w.instrumentId === null) continue;
      woBySys.set(w.instrumentId, [...(woBySys.get(w.instrumentId) ?? []), w]);
    }

    /* Who services each of these - which is NOT the same question as what a
       contract includes. The provider and the term answer "who do I call and
       will this be billed"; the entitlements further down are money, and stay
       behind the organization's own gate. So this read takes only the columns
       that decide coverage, and every viewer of the account gets it. */
    const covRows = rows.length
      ? await db.select({
          id: agreements.id, title: agreements.title, number: agreements.number,
          status: agreements.status, startsOn: agreements.startsOn, endsOn: agreements.endsOn,
          renewNoticeDays: agreements.renewNoticeDays, instrumentIds: agreements.instrumentIds,
          providerOrgId: agreements.providerOrgId,
        }).from(agreements)
          .where(and(
            eq(agreements.orgId, user.orgId),
            eq(agreements.kind, "contract"),
            forTenant(agreements.tenantOrgId, await viewTenant(user)),
          ))
          .catch(() => [])
      : [];
    const covAgreements: CoverageAgreement[] = covRows.map((a) => ({
      ...a,
      // Null stays null: it is what makes an agreement OURS, and resolving it
      // to our own name here would lose the distinction the state depends on.
      providerName: a.providerOrgId === null
        ? null
        : orgNames.find((o) => o.id === a.providerOrgId)?.name ?? "another company",
    }));

    const systems: ClientSystem[] = data.map((d) => {
      const jobs = (woBySys.get(d.id) ?? [])
        .sort((a, b) => severityOf(a.severity).rank - severityOf(b.severity).rank);
      const state = stateOf({
        down: d.down,
        openSeverities: jobs.map((w) => w.severity),
        stages: d.stages,
        pmDue: pmBySys.has(d.id),
      });
      const src = rows.find((r) => r.id === d.id);
      return {
        id: d.id,
        externalId: d.externalId,
        label: d.label,
        location: (src?.siteId !== null && src?.siteId !== undefined
          ? siteName.get(src.siteId) : "") || src?.location || "",
        state,
        why: whySentence({
          state,
          openWo: jobs[0] ? { number: jobs[0].number, title: jobs[0].title } : null,
          blockedDays: d.blockedDays,
          blockReason: src?.blockedReason ?? "",
          pmDue: pmBySys.get(d.id) ?? "",
          openParts: d.openParts,
          lastVisit: lastVisitBySys.get(d.id) ?? "",
        }),
        /* Whose move it is, as the card's footer says it. The QUEUE is one
           axis and maintenance is another - lib/pmQueue deliberately hands a
           system back out of the client's queue the day a PM falls due - but
           to the person reading the card they are the same question, and a
           footer reading "With Sierra Spectra" above a list that says "book a
           window" is the page arguing with itself. Either is their move. */
        yourMove: d.queueMine || pmBySys.has(d.id),
        /* Whether anything NAMES them, which is a different question from
           whether the machine is well. See queueNeedsThem. */
        pmDue: pmBySys.has(d.id),
        blockedOnThem: d.stages.includes(BLOCKED_STAGE)
          && d.blockedOrgId !== null && d.blockedOrgId === user.orgId,
        lastVisit: lastVisitBySys.get(d.id) ?? "",
        coverage: coverageOf(d.id, covAgreements, today, brand.operatorName),
      };
    });

    /* WHICH HALF OF THE APP THIS PERSON WORKS IN was resolved above the
       branch - the same three answers the nav reads, so a page and the nav
       above it cannot disagree. See lib/viewMode. */
    const asReseller = clientMode === "reseller";

    const todos = await clientTodos({
      orgId: user.orgId, today,
      /* A reseller gets money only. A PM is advisory on a machine being
         rebuilt and a queue chore is derived from a state that means nothing
         when a unit is supposed to be in pieces - both fired anyway, and made
         the pipeline's ordinary business look like a list of things they were
         late for. See the note on clientTodos. */
      mode: asReseller ? "reseller" : "lab",
      /* And money only for somebody at this organization who may read its
         money - the chore names the figure, so withholding the page and
         keeping the chore would withhold nothing. */
      money: await maySeeOrgMoney(user, user.orgId),
      /* The state travels with the queue, because holding a system is only a
         chore when something is pending on it - see queueNeedsThem. `systems`
         is built from `data` one-for-one just above, so the index lines up. */
      systems: data.map((d, i) => ({
        id: d.id, externalId: d.externalId, queueMine: d.queueMine, queueReason: d.queueReason,
        state: systems[i].state,
        pmDue: pmBySys.has(d.id),
        /* Parked ON THEM, chosen when it was blocked rather than inferred.
           blocked_org_id null is the operator, so a system parked while WE
           wait on a vendor raises nothing here. */
        blockedOnThem: d.stages.includes(BLOCKED_STAGE)
          && d.blockedOrgId !== null && d.blockedOrgId === user.orgId,
      })),
      systemIds: rows.map((r) => r.id),
    });

    // Visits this calendar year, from the same rule the cards use. Both halves
    // are counted, never derived.
    const closedThisYear = visitsThisYear(visits, today);
    const planned = closedThisYear.filter((v) => v.planned).length;

    /* A reseller reads a process, not a floor. Their units are inventory
       heading for a sale rather than benches that have to stay up, so the
       whole landing changes shape - see lib/clientView. Which shape THIS
       reader gets is resolved above: the org's flag with their own choice on
       top of it. */
    if (asReseller) {
      const label = (id: number) => data.find((d) => d.id === id)?.label ?? "";
      const { stages: pipeStages, stalled, units: inPipeline } = await pipelineFor(
        rows.map((r) => ({
          id: r.id, externalId: r.externalId, stages: r.stages,
          blockedReason: r.blockedReason ?? "", blockedSince: r.blockedSince,
        })),
        label,
      );
      const atGate = rows
        .flatMap((r) => ["Checkout", "Sign-off"]
          .filter((g) => r.stages.includes(g))
          .map((stage) => ({ id: r.id, externalId: r.externalId, stage })));
      const toShip = rows.filter((r) => r.stages.includes("Waiting to ship"))
        .map((r) => ({ id: r.id, externalId: r.externalId }));

      const shipped = rows.filter((r) => r.stages.includes("Shipped")).length;
      const listings = rows.filter((r) => r.forSale).map((r) => ({
        id: r.id, externalId: r.externalId, label: label(r.id),
        note: r.saleNote, token: r.listingToken,
      }));

      return (
        <div className="container wide">
          {tour}
          <PageHead
            title="Your pipeline"
            /* Their stock, not our account list. "16 units with Sierra
               Spectra" framed a reseller's own inventory as something they
               keep at our place - see coverageSummary for the same fix on the
               lab side. */
            sub={`${rows.length} unit${rows.length === 1 ? "" : "s"} · ${inPipeline} in the pipeline`}
          />
          <ResellerLanding
            stages={pipeStages}
            inPipeline={inPipeline}
            unitCount={rows.length}
            stalled={stalled}
            /* Money only. The gates and the shipping queue moved out of the
               alert band and into a work list - they are the process working,
               not a warning, and an alarm that is always on is furniture. */
            todos={rankTodos(todos)}
            ready={readyToMove({ atGate, toShip })}
            listings={listings}
            operatorName={brand.operatorName}
            shippedThisYear={shipped}
          />
        </div>
      );
    }

    /* Their own paper, and only if their own organization lets this person
       read it - the same gate the agreements page uses. Scoped to the org AND
       stamped tenant, because an agreement belongs to one workspace. */
    const canSeePaper = await maySeeAgreements(user, user.orgId);
    const coverRows = canSeePaper
      ? await db.select().from(agreements)
          .where(and(
            eq(agreements.orgId, user.orgId),
            eq(agreements.kind, "contract"),
            forTenant(agreements.tenantOrgId, await viewTenant(user)),
          ))
          .orderBy(asc(agreements.endsOn))
          .catch(() => [])
      : [];
    return (
      <div className="container wide">
        {tour}
        <PageHead
          title="Your lab"
          /* It used to read "N instruments under service with us" from the
             COUNT OF SYSTEMS THEY COULD SEE, which announced a service
             relationship over every system a client had ever shared with us -
             including one we had touched exactly once. Visibility is not a
             relationship. Now it counts the ones an agreement actually says
             are ours. */
          sub={coverageSummary(systems.map((x) => x.coverage.state))}
        />
        <ClientLanding
          systems={systems}
          todos={todos}
          operatorName={brand.operatorName}
          orgName={orgSelf?.name ?? "your organization"}
          today={today}
          q={initial.q ?? ""}
          where={initial.where ?? ""}
          coverage={
            <ClientCoverage today={today} operatorName={brand.operatorName}
              agreements={coverRows
                .filter((a) => a.status === "active")
                /* Only paper that touches a system this account actually has.
                   An account-wide contract ([] instrument list) always counts;
                   one written against systems they no longer hold does not,
                   and used to sit on the card promising visits on a machine
                   that had left the building. */
                .filter((a) => a.instrumentIds.length === 0
                  || a.instrumentIds.some((id) => rows.some((r) => r.id === id)))
                .map((a) => ({
                id: a.id, title: a.title, number: a.number, status: a.status,
                startsOn: a.startsOn, endsOn: a.endsOn, renewNoticeDays: a.renewNoticeDays,
                visitsIncluded: a.visitsIncluded, visitsUnlimited: a.visitsUnlimited,
                partsAllowanceCents: a.partsAllowanceCents, partsUnlimited: a.partsUnlimited,
                laborUnlimited: a.laborUnlimited,
                laborIncludedMinutes: a.laborIncludedMinutes, pmPartsIncluded: a.pmPartsIncluded,
                providerName: a.providerOrgId === null
                  ? null
                  : orgNames.find((o) => o.id === a.providerOrgId)?.name ?? "another company",
              }))} />
          }
          /* Service, not a relationship summary. The first tile used to count
             the systems WE held a contract on, which repeated the header and
             made the year's work about us; the header now answers coverage and
             this band answers what was actually done. Both counted, neither
             derived. */
          thisYear={[
            {
              value: String(closedThisYear.length),
              label: closedThisYear.length === 1
                ? `visit this year · ${planned} planned, ${closedThisYear.length - planned} unplanned`
                : `visits this year · ${planned} planned, ${closedThisYear.length - planned} unplanned`,
            },
            (() => {
              const touched = new Set(closedThisYear.map((v) => v.instrumentId)).size;
              return {
                value: String(touched),
                label: `instrument${touched === 1 ? "" : "s"} worked on`,
              };
            })(),
          ]}
        />
      </div>
    );
  }

  // The changelog the platform shows its own users, on the one page everyone
  // lands on. Cards this person has already dismissed never come back.
  //
  // Never under a persona: "view as" borrows a client's eyes but keeps the
  // owner's account, so a dismissal there would mark the whole batch seen and
  // swallow the staff and owner cards before the owner ever saw them as
  // themselves. The impersonated walk-through is for checking the portal, not
  // for reading news.
  return (
    <>
      {tour}
      {/* Whose move is it, in money - above the board, because an unbilled
          closed job is work that is finished and still costing. The owner's,
          though: three lines naming what the shop is owed and by whom are the
          books in miniature, and the dashboard is the one page everybody on
          the staff opens every morning. See lib/books. */}
      {seesBooks && <MoneyCard tenantOrgId={readTenant(user)} />}
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
        /* The way to the owner view lives beside the dashboard's own title
           rather than in the nav. Same gate as the page it points at - see
           lib/books - so it is never a link to a redirect. */
        ownerView={seesBooks}
        myQueueHref={user.name ? `/work?who=${encodeURIComponent(user.name)}` : "/work"}
        initial={{ q: initial.q, f: initial.f, sort: initial.sort }}
        // The ship pipeline is the shop's own axis, and a reseller client's.
        // For everyone else "Ship queue + shipped" is a tile about a business
        // they aren't in - same burial as the resale controls.
        /* The ORG's flag, deliberately, not the reader's view. Whether this
           company ships things is a fact about the company; somebody who chose
           the equipment view still works somewhere that ships. See
           lib/viewMode - a preference decides which question a page leads
           with, never what the company is. */
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
      <div className="mut t-meta" style={{ marginBottom: 10 }}>{blurb}</div>
      {rows.map((r) => (
        <div key={r.id} style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
          <Link href={`/records/${r.id}`} className="mono t-body" style={{ fontWeight: 700, textDecoration: "none", color: "var(--navy)" }}>
            {r.externalId}
          </Link>
          <span className="t-body">{r.label || <span className="mut">No assets were listed</span>}</span>
          <span className="mut t-small" style={{ marginLeft: "auto" }}>{verb} {shopTime(r.revokedAt)}</span>
        </div>
      ))}
    </div>
  );
}
