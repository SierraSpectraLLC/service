import { asc, eq, desc } from "drizzle-orm";
import { db } from "@/db";
import { instruments, instrumentGases, parts, auditLog } from "@/db/schema";
import { GAS_SYMBOL, gasAttention, partOpen } from "@/lib/stages";
import { requireUser } from "@/lib/authz";
import { redirect } from "next/navigation";
import Dashboard from "@/components/Dashboard";

export const dynamic = "force-dynamic";

export default async function Home() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }

  const rows = await db.select().from(instruments).orderBy(asc(instruments.priority), asc(instruments.externalId));
  const allParts = await db.select().from(parts);
  const allGases = await db.select().from(instrumentGases);
  const recent = await db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(200);

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
      model: i.model,
      priority: i.priority,
      stages: i.stages,
      notes: i.notes,
      openParts,
      gasIssues,
      lastActivity: last ? `${last.action} - ${last.actor.split("@")[0]}` : "",
    };
  });

  return <Dashboard data={data} canEdit={user.role !== "client_viewer"} isStaff={user.role === "owner" || user.role === "staff"} />;
}
