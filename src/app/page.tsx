import { and, asc, eq, desc } from "drizzle-orm";
import { db } from "@/db";
import { instruments, instrumentGases, parts, auditLog, sheetDiffs, taskTemplates } from "@/db/schema";
import { GAS_SYMBOL, gasAttention, partOpen } from "@/lib/stages";
import { getStageDefs } from "@/lib/stageDefs";
import { getStageSince, ageDays } from "@/lib/stageAges";
import { requireUser } from "@/lib/authz";
import { redirect } from "next/navigation";
import Dashboard from "@/components/Dashboard";

export const dynamic = "force-dynamic";

export default async function Home() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }

  const [rows, allParts, allGases, recent, openRowDiffs, stageDefList, templateList] = await Promise.all([
    db.select().from(instruments).orderBy(asc(instruments.priority), asc(instruments.externalId)),
    db.select().from(parts),
    db.select().from(instrumentGases),
    db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(200),
    db.select().from(sheetDiffs).where(and(eq(sheetDiffs.resolved, false), eq(sheetDiffs.field, "Row"))),
    getStageDefs(),
    db.select({ id: taskTemplates.id, name: taskTemplates.name }).from(taskTemplates).orderBy(asc(taskTemplates.name)),
  ]);

  // Systems the client's sheet dropped but we still track (flagged by sheet-sync).
  // Internal parity detail, so staff eyes only.
  const isStaff = user.role === "owner" || user.role === "staff";
  const droppedFromSheet = new Set(
    isStaff ? openRowDiffs.filter((d) => d.sheetValue === "(missing from sheet)").map((d) => d.externalId) : []
  );

  const stageSince = await getStageSince(rows.map((r) => r.id));

  const data = rows.map((i) => {
    // Flag systems parked in a stage for a week+ (shipped systems are done, not stuck).
    let aging = "";
    if (!i.stages.includes("Shipped")) {
      let worst = 0, worstStage = "";
      for (const s of i.stages) {
        const d = ageDays(stageSince.get(i.id)?.get(s) ?? i.createdAt);
        if (d > worst) { worst = d; worstStage = s; }
      }
      if (worst >= 7) aging = `${worst}d in ${worstStage}`;
    }
    const openParts = allParts.filter((p) => p.instrumentId === i.id && partOpen(p.status)).length;
    const gasIssues = allGases
      .filter((g) => g.instrumentId === i.id && gasAttention(g.status))
      .map((g) => `${GAS_SYMBOL[g.gas] || g.gas} ${g.status === "Not connected" ? "n/c" : g.status.toLowerCase()}`);
    const last = recent.find((a) => a.instrumentId === i.id);
    return {
      id: i.id,
      externalId: i.externalId,
      client: i.client,
      model: i.model,
      priority: i.priority,
      stages: i.stages,
      notes: i.notes,
      openParts,
      gasIssues,
      aging,
      missingFromSheet: droppedFromSheet.has(i.externalId),
      lastActivity: last ? `${last.action} - ${last.actor.split("@")[0]}` : "",
    };
  });

  return (
    <Dashboard
      data={data}
      stageDefs={stageDefList.map((d) => ({ name: d.name, bg: d.bg, fg: d.fg }))}
      templates={templateList}
      canEdit={user.role !== "client_viewer"}
      isStaff={isStaff}
    />
  );
}
