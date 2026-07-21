import { redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { instruments, eodUpdates } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { shopToday, shopTodayMDY } from "@/lib/shopday";
import EodPanel from "@/components/EodPanel";

export const dynamic = "force-dynamic";

export default async function EodPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (user.role !== "owner" && user.role !== "staff") redirect("/");

  const rows = await db.select().from(instruments).orderBy(asc(instruments.priority), asc(instruments.externalId));
  const active = rows.filter((i) => !i.stages.includes("Shipped"));
  const saved = await db.select().from(eodUpdates).where(eq(eodUpdates.date, shopToday()));

  const systems = active.map((i) => {
    const u = saved.find((s) => s.instrumentId === i.id);
    return {
      id: i.id,
      label: `${i.externalId} - ${i.model}`,
      client: i.client,
      systemUpdate: u?.systemUpdate ?? "",
      actionItem: u?.actionItem ?? "",
    };
  });

  return (
    <div className="container">
      <EodPanel systems={systems} dateMDY={shopTodayMDY()} />
    </div>
  );
}
