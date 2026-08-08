import { and, asc, eq, desc } from "drizzle-orm";
import { db } from "@/db";
import { instruments, instrumentGases, parts, auditLog, sheetDiffs, taskTemplates, people, tasks, assets } from "@/db/schema";
import { GAS_SYMBOL, gasAttention, partOpen, assetAttention } from "@/lib/stages";
import { getStageDefs } from "@/lib/stageDefs";
import { composeSystemLabel } from "@/lib/systemLabel";
import { shopToday } from "@/lib/shopday";
import { requireUser } from "@/lib/authz";
import { redirect } from "next/navigation";
import Dashboard from "@/components/Dashboard";

export const dynamic = "force-dynamic";

export default async function Home() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }

  const [rows, allParts, allGases, recent, openRowDiffs, stageDefList, templateList, peopleRows, taskRows, assetRows, clientRows] = await Promise.all([
    db.select().from(instruments).where(eq(instruments.archived, false)).orderBy(asc(instruments.priority), asc(instruments.externalId)),
    db.select().from(parts),
    db.select().from(instrumentGases),
    db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(200),
    db.select().from(sheetDiffs).where(and(eq(sheetDiffs.resolved, false), eq(sheetDiffs.field, "Row"))),
    getStageDefs(),
    db.select({ id: taskTemplates.id, name: taskTemplates.name }).from(taskTemplates).orderBy(asc(taskTemplates.name)),
    db.select({ name: people.name }).from(people).orderBy(asc(people.org), asc(people.name)),
    db.select({ instrumentId: tasks.instrumentId, dueDate: tasks.dueDate, state: tasks.state }).from(tasks),
    db.select({ instrumentId: assets.instrumentId, kind: assets.kind, model: assets.model, status: assets.status, sortOrder: assets.sortOrder }).from(assets),
    // Archived systems included, so retiring the last system for a client
    // doesn't drop them out of the picker.
    db.selectDistinct({ client: instruments.client }).from(instruments),
  ]);

  // Systems the client's sheet dropped but we still track (flagged by sheet-sync).
  // Internal parity detail, so staff eyes only.
  const isStaff = user.role === "owner" || user.role === "staff";
  const droppedFromSheet = new Set(
    isStaff ? openRowDiffs.filter((d) => d.sheetValue === "(missing from sheet)").map((d) => d.externalId) : []
  );

  const today = shopToday();
  const overdueBy = new Map<number, number>();
  for (const t of taskRows) {
    if (t.state === "Done" || !t.dueDate || t.dueDate >= today) continue;
    overdueBy.set(t.instrumentId, (overdueBy.get(t.instrumentId) ?? 0) + 1);
  }

  const data = rows.map((i) => {
    const openParts = allParts.filter((p) => p.instrumentId === i.id && partOpen(p.status)).length;
    const gasIssues = allGases
      .filter((g) => g.instrumentId === i.id && gasAttention(g.status))
      .map((g) => `${GAS_SYMBOL[g.gas] || g.gas} ${g.status === "Not connected" ? "n/c" : g.status.toLowerCase()}`);
    const last = recent.find((a) => a.instrumentId === i.id);
    return {
      id: i.id,
      externalId: i.externalId,
      client: i.client,
      // A system is what it's built from; the stored description is only a
      // fallback for systems whose assets haven't been entered yet.
      label: composeSystemLabel(assetRows.filter((a) => a.instrumentId === i.id), i.model),
      priority: i.priority,
      lead: i.lead,
      stages: i.stages,
      notes: i.notes,
      openParts,
      gasIssues,
      overdue: overdueBy.get(i.id) ?? 0,
      assetIssues: assetRows
        .filter((a) => a.instrumentId === i.id && assetAttention(a.status))
        .map((a) => `${a.kind.toLowerCase()} ${a.status === "Down" ? "down" : "attn"}`),
      missingFromSheet: droppedFromSheet.has(i.externalId),
      lastActivity: last ? `${last.action} - ${last.actor.split("@")[0]}` : "",
    };
  });

  return (
    <Dashboard
      data={data}
      stageDefs={stageDefList.map((d) => ({ name: d.name, bg: d.bg, fg: d.fg }))}
      templates={templateList}
      people={peopleRows.map((p) => p.name)}
      clients={clientRows.map((c) => c.client).filter(Boolean)}
      canEdit={user.role !== "client_viewer"}
      isStaff={isStaff}
    />
  );
}
