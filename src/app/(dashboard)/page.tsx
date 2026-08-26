import { and, asc, eq, desc, inArray, isNull, lte, ne, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "@/db";
import Link from "next/link";
import { instruments, instrumentGases, parts, auditLog, sheetDiffs, tasks, assets, vocabTerms, engagementRecords, orgs, orgSites, attachments, workOrders, users, pmSchedules, agreements } from "@/db/schema";
import { coverageOf, coverageSummary, type CoverageAgreement } from "@/lib/coverage";
import { daysSince, queueView } from "@/lib/queue";
import { getBrand } from "@/lib/brand";
import { getModules } from "@/lib/flags";
import { shopMonthDay, shopTime } from "@/lib/shopday";
import { BLOCKED_STAGE, GAS_SYMBOL, gasAttention, partOpen, assetAttention } from "@/lib/stages";
import { expiryAttention, expiryLabel } from "@/lib/gxp";
import { getStageDefs } from "@/lib/stageDefs";
import { systemLabel } from "@/lib/systemLabel";
import { shopToday } from "@/lib/shopday";
import { directoryNames, visibleDirectory } from "@/lib/directory";
import { currentUser, requireUser, viewContext } from "@/lib/authz";
import { forTenant, maySeeAgreements, viewTenant, visibleOrgs, visibleSystemIds } from "@/lib/tenancy";
import { clientOptions } from "@/lib/clientNames";
import { shelveRecords } from "@/lib/records";
import { severityOf, woOpen } from "@/lib/workOrders";
import { redirect } from "next/navigation";
import Dashboard from "@/components/Dashboard";
import Landing from "@/components/Landing";
import ClientLanding, { type ClientSystem } from "@/components/ClientLanding";
import { clientTodos, pipelineFor, readyToMove, stateOf, whySentence } from "@/lib/clientLandingData";
import { rankTodos } from "@/lib/clientView";
import ResellerLanding from "@/components/ResellerLanding";
import { PageHead } from "@/components/ui";
import ClientCoverage from "@/components/ClientCoverage";
import MoneyCard from "@/components/MoneyCard";
import WhatsNew from "@/components/WhatsNew";
import { WHATS_NEW, unseenFor } from "@/lib/whatsNew";

export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: {
  searchParams: Promise<{ q?: string; f?: string; sort?: string; where?: string }>;
}) {
  const initial = await searchParams;
  // The apex answers strangers now, so a missing session is not an error here
  // - it is the other half of this route. Bouncing to /login would have made
  // the front door of the site a sign-in form.
  const visitor = await currentUser();
  if (!visitor) {
    const [brand, modules] = await Promise.all([getBrand(), getModules()]);
    return <Landing brandName={brand.name} operatorName={brand.operatorName}
      catalogOn={modules.publicCatalog} contactEmail={brand.contactEmail} />;
  }
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
    db.select({ instrumentId: tasks.instrumentId, assetId: tasks.assetId, dueDate: tasks.dueDate, state: tasks.state, assignee: tasks.assignee, title: tasks.title }).from(tasks).where(mine(tasks.instrumentId)),
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

  /* ── The client's own product ──────────────────────────────────────────
     Everything below runs only for a non-staff viewer, and only for one who
     belongs to an organization. Staff pay nothing for it; a client stops
     paying for the parts of the board that were never theirs. */
  if (!isStaff && user.orgId !== null) {
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

    /* Last visit: the most recent CLOSED job on this instrument. A visit is a
       job somebody finished, which is the only record of one this app keeps -
       it is not inferred from an audit line, which would count a field edit as
       an engineer standing in the room. */
    const lastVisitAt = new Map<number, Date>();
    for (const w of woRows) {
      if (w.instrumentId === null || w.closedAt === null) continue;
      const seen = lastVisitAt.get(w.instrumentId);
      if (!seen || w.closedAt > seen) lastVisitAt.set(w.instrumentId, w.closedAt);
    }
    const lastVisitBySys = new Map(
      [...lastVisitAt].map(([id, at]) => [id, shopMonthDay(at)] as const));

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
        lastVisit: lastVisitBySys.get(d.id) ?? "",
        coverage: coverageOf(d.id, covAgreements, today, brand.operatorName),
      };
    });

    const orgSelf = orgNames.find((o) => o.id === user.orgId);

    const todos = await clientTodos({
      orgId: user.orgId, today,
      /* A reseller gets money only. A PM is advisory on a machine being
         rebuilt and a queue chore is derived from a state that means nothing
         when a unit is supposed to be in pieces - both fired anyway, and made
         the pipeline's ordinary business look like a list of things they were
         late for. See the note on clientTodos. */
      mode: orgSelf?.resaleEnabled ? "reseller" : "lab",
      /* The state travels with the queue, because holding a system is only a
         chore when something is pending on it - see queueNeedsThem. `systems`
         is built from `data` one-for-one just above, so the index lines up. */
      systems: data.map((d, i) => ({
        id: d.id, externalId: d.externalId, queueMine: d.queueMine, queueReason: d.queueReason,
        state: systems[i].state,
      })),
      systemIds: rows.map((r) => r.id),
    });

    // Visits: closed jobs this calendar year, split the way the work orders
    // themselves are already labelled. Both halves are counted, never derived.
    const yearStart = `${today.slice(0, 4)}-01-01`;
    const closedThisYear = woRows.filter((w) =>
      w.closedAt !== null && w.closedAt.toISOString().slice(0, 10) >= yearStart);
    const planned = closedThisYear.filter((w) => w.severity === "Planned").length;

    /* A reseller reads a process, not a floor. Their units are inventory
       heading for a sale rather than benches that have to stay up, so the
       whole landing changes shape - see lib/clientView. resaleEnabled already
       drove one tile on the staff board; here it picks the mode. */
    if (orgSelf?.resaleEnabled) {
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
              const touched = new Set(closedThisYear
                .map((w) => w.instrumentId).filter((x): x is number => x !== null)).size;
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
  const { persona } = await viewContext();
  const [me] = persona ? [] : await db.select({ seen: users.whatsNewSeen }).from(users)
    .where(eq(users.email, user.email.toLowerCase())).catch(() => []);
  const newsCards = persona ? [] : unseenFor(WHATS_NEW, user.role, me?.seen ?? "");

  return (
    <>
      {newsCards.length > 0 && (
        <WhatsNew cards={newsCards.map((c) => ({
          key: c.key, date: c.date, title: c.title, body: c.body, image: c.image, href: c.href,
        }))} />
      )}
      {/* Whose move is it, in money - above the board, because an unbilled
          closed job is work that is finished and still costing. */}
      {isStaff && <MoneyCard />}
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
        myQueueHref={user.name ? `/work?who=${encodeURIComponent(user.name)}` : "/work"}
        initial={{ q: initial.q, f: initial.f, sort: initial.sort }}
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
