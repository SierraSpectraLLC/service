import { redirect } from "next/navigation";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { instruments, eodUpdates, tasks, parts, instrumentGases, auditLog, appSettings, people, systemShares, orgs } from "@/db/schema";
import { getSystemLabels } from "@/lib/systemLabel";
import { requireUser } from "@/lib/authz";
import { getModules } from "@/lib/flags";
import { partOpen, gasAttention } from "@/lib/stages";
import { shopToday, shopTodayMDY, shopTime } from "@/lib/shopday";
import EodPanel from "@/components/EodPanel";
import EodDateNav from "@/components/EodDateNav";

export const dynamic = "force-dynamic";

const mdy = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y.slice(2)}`;
};

export default async function EodPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (user.role !== "owner" && user.role !== "staff") redirect("/");
  if (!(await getModules()).eod) redirect("/");
  // Who the report goes to, for the send button's copy.
  const [reportCfg] = await db.select({ sheetOrgId: appSettings.sheetOrgId }).from(appSettings).where(eq(appSettings.id, 1));
  const reportClient = reportCfg?.sheetOrgId
    ? (await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, reportCfg.sheetOrgId)))[0]?.name ?? ""
    : "";

  const { date: dateParam } = await searchParams;
  const today = shopToday();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateParam ?? "") ? dateParam! : today;
  const isToday = date === today;

  const recorded = await db.selectDistinct({ date: eodUpdates.date }).from(eodUpdates).orderBy(desc(eodUpdates.date)).limit(60);
  const dates = recorded.map((r) => r.date);

  let systems;
  let sentInfo = "";
  let canSend = false;
  if (isToday) {
    // Today: every active operator-led system, editable, with autofill
    // suggestions. Systems led by the client's own people stay out.
    const [rows, roster, [cfg]] = await Promise.all([
      db.select().from(instruments).where(eq(instruments.archived, false)).orderBy(asc(instruments.priority), asc(instruments.externalId)),
      db.select().from(people),
      db.select().from(appSettings).where(eq(appSettings.id, 1)),
    ]);
    const sheetOrgName = cfg?.sheetOrgId
      ? (await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, cfg.sheetOrgId)))[0]?.name ?? ""
      : "";
    const clientLed = new Set(roster.filter((p) => sheetOrgName && p.org === sheetOrgName).map((p) => p.name));
    // The report belongs to one organization, so only their systems appear -
    // matching what composeEodEmail will actually send.
    const sharedIds = cfg?.sheetOrgId
      ? new Set((await db.select({ instrumentId: systemShares.instrumentId }).from(systemShares)
          .where(eq(systemShares.orgId, cfg.sheetOrgId))).map((r) => r.instrumentId))
      : null;
    const active = rows.filter((i) =>
      !i.stages.includes("Shipped") && !clientLed.has(i.lead) && (sharedIds === null || sharedIds.has(i.id)));
    const ids = active.map((i) => i.id);

    const [saved, taskRows, partRows, gasRows, recentAudit, [settings]] = await Promise.all([
      db.select().from(eodUpdates).where(eq(eodUpdates.date, today)),
      ids.length ? db.select().from(tasks).where(inArray(tasks.instrumentId, ids)) : Promise.resolve([]),
      ids.length ? db.select().from(parts).where(inArray(parts.instrumentId, ids)) : Promise.resolve([]),
      ids.length ? db.select().from(instrumentGases).where(inArray(instrumentGases.instrumentId, ids)) : Promise.resolve([]),
      db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(400),
      db.select().from(appSettings).where(eq(appSettings.id, 1)),
    ]);

    const labels = await getSystemLabels(active);
    const labelFor = (i: { id: number; externalId: string }) => {
      const named = labels.get(i.id) ?? "";
      return named ? `${i.externalId} - ${named}` : i.externalId;
    };

    const lastSend = recentAudit.find((a) => a.entityType === "eod" && a.entityId === today);
    sentInfo = lastSend ? `Sent ${shopTime(lastSend.createdAt)} by ${lastSend.actor.split("@")[0]}` : "";
    canSend = !!(settings?.eodRecipients ?? "").trim();

    // Today's human activity, in shop time (audit timestamps are UTC).
    const tz = process.env.SHOP_TZ || "America/Los_Angeles";
    const todayAudit = recentAudit.filter(
      (a) => a.actor !== "sheet-sync" && a.createdAt.toLocaleDateString("en-CA", { timeZone: tz }) === today
    );

    systems = active.map((i) => {
      const u = saved.find((s) => s.instrumentId === i.id);
      // Suggested update: what actually happened on this system today, oldest first.
      const happenings = todayAudit
        .filter((a) => a.instrumentId === i.id)
        .reverse()
        .map((a) => (a.field === "note" && a.newValue ? a.newValue : a.action));
      const suggestedUpdate = [...new Set(happenings)].slice(0, 6).join("; ");
      // Suggested action item: blocked work first, then parts in flight, then gas needs.
      const blocked = taskRows.filter((t) => t.instrumentId === i.id && t.state === "Blocked").map((t) => `Blocked: ${t.title}`);
      const dueSoon = taskRows
        .filter((t) => t.instrumentId === i.id && t.state !== "Done" && t.dueDate && t.dueDate <= today)
        .map((t) => `${t.dueDate < today ? "Overdue" : "Due today"}: ${t.title}`);
      const waiting = partRows.filter((p) => p.instrumentId === i.id && partOpen(p.status)).map((p) => `${p.name} (${p.status.toLowerCase()})`);
      const gas = gasRows.filter((g) => g.instrumentId === i.id && gasAttention(g.status)).map((g) => `${g.gas} ${g.status.toLowerCase()}`);
      const suggestedAction = [...dueSoon, ...blocked, ...waiting, ...gas].slice(0, 3).join("; ");
      return {
        id: i.id,
        label: labelFor(i),
        client: i.client,
        systemUpdate: u?.systemUpdate ?? "",
        actionItem: u?.actionItem ?? "",
        skipped: u?.skipped ?? false,
        suggestedUpdate,
        suggestedAction,
      };
    });
  } else {
    // Past day: read-only snapshot of what was recorded.
    const saved = await db.select().from(eodUpdates).where(eq(eodUpdates.date, date));
    const ids = saved.map((s) => s.instrumentId);
    const insts = ids.length
      ? await db.select().from(instruments).where(inArray(instruments.id, ids)).orderBy(asc(instruments.priority), asc(instruments.externalId))
      : [];
    const labels = await getSystemLabels(insts);
    const labelFor = (i: { id: number; externalId: string }) => {
      const named = labels.get(i.id) ?? "";
      return named ? `${i.externalId} - ${named}` : i.externalId;
    };
    systems = insts.map((i) => {
      const u = saved.find((s) => s.instrumentId === i.id)!;
      return {
        id: i.id,
        label: labelFor(i),
        client: i.client,
        systemUpdate: u.systemUpdate,
        actionItem: u.actionItem,
        skipped: u.skipped,
        suggestedUpdate: "",
        suggestedAction: "",
      };
    });
  }

  return (
    <div className="container">
      <EodDateNav date={date} today={today} dates={dates} />
      <EodPanel systems={systems} dateMDY={isToday ? shopTodayMDY() : mdy(date)} readOnly={!isToday}
        canSend={canSend} sentInfo={sentInfo} clientName={reportClient || undefined} />
    </div>
  );
}
