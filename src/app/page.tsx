import { and, asc, eq, desc, inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { instruments, instrumentGases, parts, auditLog, sheetDiffs, people, tasks, assets, vocabTerms } from "@/db/schema";
import { GAS_SYMBOL, gasAttention, partOpen, assetAttention } from "@/lib/stages";
import { getStageDefs } from "@/lib/stageDefs";
import { composeSystemLabel } from "@/lib/systemLabel";
import { shopToday } from "@/lib/shopday";
import { requireUser } from "@/lib/authz";
import { visibleSystemIds } from "@/lib/tenancy";
import { redirect } from "next/navigation";
import Dashboard from "@/components/Dashboard";

export const dynamic = "force-dynamic";

export default async function Home() {
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
    db.select().from(sheetDiffs).where(and(eq(sheetDiffs.resolved, false), eq(sheetDiffs.field, "Row"))),
    getStageDefs(),
    db.select({ name: people.name }).from(people).orderBy(asc(people.org), asc(people.name)),
    db.select({ instrumentId: tasks.instrumentId, dueDate: tasks.dueDate, state: tasks.state }).from(tasks).where(mine(tasks.instrumentId)),
    db.select({ instrumentId: assets.instrumentId, kind: assets.kind, model: assets.model, status: assets.status, sortOrder: assets.sortOrder }).from(assets).where(mine(assets.instrumentId)),
    // Archived systems included, so retiring the last system for a client (or
    // in a category) doesn't drop it out of the pickers.
    db.select({ client: instruments.client, category: instruments.category }).from(instruments).where(mine(instruments.id)),
    db.select({ name: vocabTerms.name }).from(vocabTerms).where(eq(vocabTerms.kind, "category")),
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
    // Asset-owned tasks have no system to count against.
    if (t.instrumentId === null || t.state === "Done" || !t.dueDate || t.dueDate >= today) continue;
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
      category: i.category,
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
      people={peopleRows.map((p) => p.name)}
      clients={allSystems.map((c) => c.client).filter(Boolean)}
      categories={[...allSystems.map((c) => c.category), ...vocabCats.map((v) => v.name)].filter(Boolean)}
      canEdit={user.role !== "client_viewer"}
      isStaff={isStaff}
    />
  );
}
