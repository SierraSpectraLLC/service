import { redirect } from "next/navigation";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { eodUpdates, tasks, parts, instrumentGases, auditLog } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { getModules } from "@/lib/flags";
import { partOpen, gasAttention } from "@/lib/stages";
import { shopToday, shopTodayMDY, shopTime } from "@/lib/shopday";
import { collectEodEntries, eodGroups } from "@/lib/eodEmail";
import EodPanel from "@/components/EodPanel";
import EodDateNav from "@/components/EodDateNav";

export const dynamic = "force-dynamic";

const mdy = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y.slice(2)}`;
};

/**
 * One report per client. Each group is the work a client owns, with its own
 * recipients and its own send button, so nothing can carry one client's systems
 * into another's email. Updates themselves are written on each system's or
 * asset's own page and picked up here.
 */
export default async function EodPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (user.role !== "owner" && user.role !== "staff") redirect("/");
  if (!(await getModules()).eod) redirect("/");

  const { date: dateParam } = await searchParams;
  const today = shopToday();
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateParam ?? "") ? dateParam! : today;
  const isToday = date === today;

  const [recorded, groups, recentAudit] = await Promise.all([
    db.selectDistinct({ date: eodUpdates.date }).from(eodUpdates).orderBy(desc(eodUpdates.date)).limit(60),
    eodGroups(date, !isToday),
    db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(400),
  ]);
  const dates = recorded.map((r) => r.date);

  // Autofill suggestions come from what actually happened today, so a blank
  // line is one keystroke from a real update.
  const tz = process.env.SHOP_TZ || "America/Los_Angeles";
  const todayAudit = isToday
    ? recentAudit.filter((a) => a.actor !== "sheet-sync" && a.createdAt.toLocaleDateString("en-CA", { timeZone: tz }) === today)
    : [];

  const built = await Promise.all(groups.map(async (g) => {
    const entries = await collectEodEntries(date, g.orgId, !isToday);
    const sysIds = entries.filter((e) => e.kind === "system").map((e) => e.id);
    const [taskRows, partRows, gasRows] = isToday && sysIds.length
      ? await Promise.all([
          db.select().from(tasks).where(inArray(tasks.instrumentId, sysIds)),
          db.select().from(parts).where(inArray(parts.instrumentId, sysIds)),
          db.select().from(instrumentGases).where(inArray(instrumentGases.instrumentId, sysIds)),
        ])
      : [[], [], []];

    const last = recentAudit.find((a) => a.entityType === "eod" && a.entityId === `${date}:${g.orgId ?? "own"}`);
    return {
      orgId: g.orgId,
      name: g.name,
      canSend: isToday && !!g.recipients.trim(),
      recipientCount: g.recipients.split(",").filter((x) => x.trim()).length,
      sentInfo: last ? `Sent ${shopTime(last.createdAt)} by ${last.actor.split("@")[0]}` : "",
      entries: entries.map((e) => {
        if (!isToday || e.kind !== "system") {
          return { ...e, suggestedUpdate: "", suggestedAction: "" };
        }
        const happenings = todayAudit
          .filter((a) => a.instrumentId === e.id)
          .reverse()
          .map((a) => (a.field === "note" && a.newValue ? a.newValue : a.action));
        const suggestedUpdate = [...new Set(happenings)].slice(0, 6).join("; ");
        const blocked = taskRows.filter((t) => t.instrumentId === e.id && t.state === "Blocked").map((t) => `Blocked: ${t.title}`);
        const dueSoon = taskRows
          .filter((t) => t.instrumentId === e.id && t.state !== "Done" && t.dueDate && t.dueDate <= today)
          .map((t) => `${t.dueDate < today ? "Overdue" : "Due today"}: ${t.title}`);
        const waiting = partRows.filter((p) => p.instrumentId === e.id && partOpen(p.status)).map((p) => `${p.name} (${p.status.toLowerCase()})`);
        const gas = gasRows.filter((gr) => gr.instrumentId === e.id && gasAttention(gr.status)).map((gr) => `${gr.gas} ${gr.status.toLowerCase()}`);
        return { ...e, suggestedUpdate, suggestedAction: [...dueSoon, ...blocked, ...waiting, ...gas].slice(0, 3).join("; ") };
      }),
    };
  }));

  // A past day only shows groups that recorded something.
  const shown = isToday ? built : built.filter((g) => g.entries.length > 0);

  return (
    <div className="container wide">
      <EodDateNav date={date} today={today} dates={dates} />
      {shown.map((g) => (
        <EodPanel key={g.orgId ?? "own"} clientName={g.name} orgId={g.orgId}
          entries={g.entries} dateMDY={isToday ? shopTodayMDY() : mdy(date)} readOnly={!isToday}
          canSend={g.canSend} recipientCount={g.recipientCount} sentInfo={g.sentInfo} />
      ))}
      {shown.length === 0 && (
        <div className="card"><div className="mut" style={{ fontSize: 13 }}>Nothing recorded for this day.</div></div>
      )}
    </div>
  );
}
