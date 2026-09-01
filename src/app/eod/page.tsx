import { redirect } from "next/navigation";
import { desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { eodUpdates, tasks, parts, instrumentGases, auditLog } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { getModules } from "@/lib/flags";
import { partOpen, gasAttention } from "@/lib/stages";
import { shopToday, shopTodayMDY, shopTime } from "@/lib/shopday";
import { collectEodEntries, composeEodEmail, eodGroups } from "@/lib/eodEmail";
import { forTenant, readTenant } from "@/lib/tenancy";
import { visibleDirectory } from "@/lib/directory";
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
  /* A past day is WRITABLE now, so it is collected as backfill: what was
     recorded that day, plus what the shop has today, so a line nobody got to
     can still be written. See lib/eodEmail.EodMode - the read-only reading is
     still there, it is just not what this page asks for. */
  const mode = isToday ? "live" as const : "backfill" as const;

  const [recorded, groups, recentAudit, people] = await Promise.all([
    db.selectDistinct({ date: eodUpdates.date }).from(eodUpdates)
      .where(forTenant(eodUpdates.tenantOrgId, readTenant(user)))
      .orderBy(desc(eodUpdates.date)).limit(60),
    eodGroups(date, mode, readTenant(user)),
    db.select().from(auditLog).where(forTenant(auditLog.tenantOrgId, readTenant(user)))
      .orderBy(desc(auditLog.createdAt)).limit(400),
    // Who this viewer may name on a line. Same list the server validates
    // against, so the picker cannot offer a choice the save would refuse.
    visibleDirectory(user),
  ]);
  const dates = recorded.map((r) => r.date);

  // Autofill suggestions come from what actually happened today, so a blank
  // line is one keystroke from a real update.
  const tz = process.env.SHOP_TZ || "America/Los_Angeles";
  /* What happened ON THE DAY being written, which for today is today. The
     audit read is the last 400 rows, so a day far enough back simply suggests
     nothing - which is the honest answer rather than today's work offered as
     Friday's. */
  const dayAudit = recentAudit.filter((a) => a.actor !== "sheet-sync"
    && a.createdAt.toLocaleDateString("en-CA", { timeZone: tz }) === date);

  const built = await Promise.all(groups.map(async (g) => {
    const entries = await collectEodEntries(date, g.orgId, mode, readTenant(user));
    const sysIds = entries.filter((e) => e.kind === "system").map((e) => e.id);
    const [taskRows, partRows, gasRows] = sysIds.length
      ? await Promise.all([
          db.select().from(tasks).where(inArray(tasks.instrumentId, sysIds)),
          db.select().from(parts).where(inArray(parts.instrumentId, sysIds)),
          db.select().from(instrumentGases).where(inArray(instrumentGases.instrumentId, sysIds)),
        ])
      : [[], [], []];

    const last = recentAudit.find((a) => a.entityType === "eod" && a.entityId === `${date}:${g.orgId ?? "own"}`);
    // The preview shows the mail itself, so it has to BE the mail: composed by
    // the same function the send uses, with the same internal-line exclusions.
    const composed = await composeEodEmail(date, isToday ? shopTodayMDY() : mdy(date), g.orgId, readTenant(user), mode);
    const recipients = g.recipients.split(",").map((x) => x.trim()).filter(Boolean);
    return {
      orgId: g.orgId,
      name: g.name,
      canSend: isToday && !!g.recipients.trim(),
      recipientCount: recipients.length,
      recipients,
      emailSubject: composed.subject,
      emailHtml: composed.filled > 0 ? composed.html : "",
      sentInfo: last ? `Sent ${shopTime(last.createdAt)} by ${last.actor.split("@")[0]}` : "",
      entries: entries.map((e) => {
        if (e.kind !== "system") return { ...e, suggestedUpdate: "", suggestedAction: "" };
        // Only a system has activity to suggest from; off-system work is the
        // one kind of line nothing else in the app knows about.
        const happenings = dayAudit
          .filter((a) => a.instrumentId === e.id)
          .reverse()
          .map((a) => (a.field === "note" && a.newValue ? a.newValue : a.action));
        const suggestedUpdate = [...new Set(happenings)].slice(0, 6).join("; ");
        /* Action items are read from what is open NOW. On today that is the
           point; on a past day it would offer this morning's blocked task as
           something to have written last Friday, so the suggestion is left to
           the audit line above and the action box starts empty. */
        if (!isToday) return { ...e, suggestedUpdate, suggestedAction: "" };
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

  /* Every group, on any day. The old filter existed because a past day could
     only be READ - a client with nothing recorded had nothing to show. Now it
     has something to show: the blank lines somebody came here to fill in. */
  const shown = built;

  return (
    <div className="container wide">
      <div className="crumb">Operations › <b>EOD update</b></div>
      <div className="page-head">
        <h1 className="page-title">EOD update</h1>
        <span className="page-actions"><EodDateNav date={date} today={today} dates={dates} /></span>
      </div>
      {shown.map((g) => (
        <EodPanel key={g.orgId ?? "own"} clientName={g.name} orgId={g.orgId}
          entries={g.entries} dateMDY={isToday ? shopTodayMDY() : mdy(date)} writeOn={isToday ? "" : date}
          canSend={g.canSend} recipientCount={g.recipientCount} sentInfo={g.sentInfo}
          emailSubject={g.emailSubject} emailHtml={g.emailHtml} recipients={g.recipients}
          people={people.map((p) => ({ name: p.name, org: p.org }))} me={user.name} />
      ))}
      {shown.length === 0 && (
        <div className="card">
          <div className="empty"><b>Nothing recorded for this day</b></div>
        </div>
      )}
    </div>
  );
}
