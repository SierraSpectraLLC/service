import { redirect } from "next/navigation";
import { asc, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { instruments, eodUpdates, tasks, parts, instrumentGases, auditLog } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { partOpen, gasAttention } from "@/lib/stages";
import { shopToday, shopTodayMDY } from "@/lib/shopday";
import EodPanel from "@/components/EodPanel";

export const dynamic = "force-dynamic";

export default async function EodPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (user.role !== "owner" && user.role !== "staff") redirect("/");

  const today = shopToday();
  const rows = await db.select().from(instruments).orderBy(asc(instruments.priority), asc(instruments.externalId));
  const active = rows.filter((i) => !i.stages.includes("Shipped"));
  const ids = active.map((i) => i.id);

  const [saved, taskRows, partRows, gasRows, recentAudit] = await Promise.all([
    db.select().from(eodUpdates).where(eq(eodUpdates.date, today)),
    ids.length ? db.select().from(tasks).where(inArray(tasks.instrumentId, ids)) : Promise.resolve([]),
    ids.length ? db.select().from(parts).where(inArray(parts.instrumentId, ids)) : Promise.resolve([]),
    ids.length ? db.select().from(instrumentGases).where(inArray(instrumentGases.instrumentId, ids)) : Promise.resolve([]),
    db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(400),
  ]);

  // Today's human activity, in shop time (audit timestamps are UTC).
  const tz = process.env.SHOP_TZ || "America/Los_Angeles";
  const todayAudit = recentAudit.filter(
    (a) => a.actor !== "sheet-sync" && a.createdAt.toLocaleDateString("en-CA", { timeZone: tz }) === today
  );

  const systems = active.map((i) => {
    const u = saved.find((s) => s.instrumentId === i.id);

    // Suggested update: what actually happened on this system today, oldest first.
    // Freeform notes carry their text; everything else uses the audit summary.
    const happenings = todayAudit
      .filter((a) => a.instrumentId === i.id)
      .reverse()
      .map((a) => (a.field === "note" && a.newValue ? a.newValue : a.action));
    const suggestedUpdate = [...new Set(happenings)].slice(0, 6).join("; ");

    // Suggested action item: blocked work first, then parts in flight, then gas needs.
    const blocked = taskRows.filter((t) => t.instrumentId === i.id && t.state === "Blocked").map((t) => `Blocked: ${t.title}`);
    const waiting = partRows.filter((p) => p.instrumentId === i.id && partOpen(p.status)).map((p) => `${p.name} (${p.status.toLowerCase()})`);
    const gas = gasRows.filter((g) => g.instrumentId === i.id && gasAttention(g.status)).map((g) => `${g.gas} ${g.status.toLowerCase()}`);
    const suggestedAction = [...blocked, ...waiting, ...gas].slice(0, 3).join("; ");

    return {
      id: i.id,
      label: `${i.externalId} - ${i.model}`,
      client: i.client,
      systemUpdate: u?.systemUpdate ?? "",
      actionItem: u?.actionItem ?? "",
      skipped: u?.skipped ?? false,
      suggestedUpdate,
      suggestedAction,
    };
  });

  return (
    <div className="container">
      <EodPanel systems={systems} dateMDY={shopTodayMDY()} />
    </div>
  );
}
