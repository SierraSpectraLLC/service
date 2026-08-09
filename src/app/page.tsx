import { and, asc, eq, desc, inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "@/db";
import Link from "next/link";
import { instruments, instrumentGases, parts, auditLog, sheetDiffs, people, tasks, assets, vocabTerms, engagementRecords } from "@/db/schema";
import { shopTime } from "@/lib/shopday";
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

  // A service provider's shelf of past engagements: frozen records kept from
  // systems whose access was later revoked. Only their own org's records.
  const pastEngagements = user.orgId === null ? [] : await db
    .select({ id: engagementRecords.id, externalId: engagementRecords.externalId, label: engagementRecords.label, revokedAt: engagementRecords.revokedAt })
    .from(engagementRecords).where(eq(engagementRecords.orgId, user.orgId))
    .orderBy(desc(engagementRecords.revokedAt));

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
    <>
      <Dashboard
        data={data}
        stageDefs={stageDefList.map((d) => ({ name: d.name, bg: d.bg, fg: d.fg }))}
        people={peopleRows.map((p) => p.name)}
        clients={allSystems.map((c) => c.client).filter(Boolean)}
        categories={[...allSystems.map((c) => c.category), ...vocabCats.map((v) => v.name)].filter(Boolean)}
        canEdit={user.role !== "client_viewer"}
        isStaff={isStaff}
      />
      {pastEngagements.length > 0 && (
        <div className="container" style={{ paddingTop: 0 }}>
          <div className="card">
            <div className="card-title">Past engagements</div>
            <div className="mut" style={{ fontSize: 11, marginBottom: 10 }}>
              Frozen, read-only records from engagements that ended.
            </div>
            {pastEngagements.map((r) => (
              <div key={r.id} style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", padding: "6px 0", borderTop: "1px solid var(--line)" }}>
                <Link href={`/records/${r.id}`} className="mono" style={{ fontWeight: 700, fontSize: 13, textDecoration: "none", color: "var(--navy)" }}>
                  {r.externalId}
                </Link>
                <span style={{ fontSize: 13 }}>{r.label || <span className="mut">No assets were listed</span>}</span>
                <span className="mut" style={{ fontSize: 12, marginLeft: "auto" }}>ended {shopTime(r.revokedAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
