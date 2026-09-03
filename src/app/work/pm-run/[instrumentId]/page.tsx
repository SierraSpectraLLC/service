import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { instruments } from "@/db/schema";
import { requireEditor } from "@/lib/authz";
import { assertSystemEditable } from "@/lib/tenancy";
import { shopToday } from "@/lib/shopday";
import { flagOn } from "@/lib/custody/flags";
import { planStatusFor } from "@/lib/custody/plan";
import { sheetRowsFor } from "@/lib/custody/sheets";
import { parseChecklist } from "@/lib/checklist";
import PmRun from "@/components/PmRun";

export const dynamic = "force-dynamic";

/** The run screen: the machine's plan as tri-state rows, with where each step stands read off the chain. */
export default async function PmRunPage({ params }: { params: Promise<{ instrumentId: string }> }) {
  let user;
  try { user = await requireEditor(); } catch { redirect("/login"); }
  if (!(await flagOn("custody.sheets"))) notFound();
  const { instrumentId } = await params;
  const id = parseInt(instrumentId);
  if (isNaN(id)) notFound();
  try { await assertSystemEditable(user, id); } catch { notFound(); }
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, id));
  if (!inst) notFound();
  const today = shopToday();
  const [rows, plan] = await Promise.all([sheetRowsFor(id), planStatusFor(id, today)]);
  const status = new Map(plan.map((p) => [p.key, p]));
  return (
    <div className="container page">
      <div className="crumb"><b>PM run</b> · {inst.externalId}</div>
      {rows.length === 0
        ? <div className="card mut t-body">Nothing on this machine&apos;s plan carries a procedure key yet. Give its schedules procedures in the catalog first.</div>
        : <PmRun instrumentId={id} externalId={inst.externalId} rows={rows.map((r) => {
            const st = status.get(r.key);
            return {
              ...r, steps: parseChecklist(r.checklist).filter((l) => !l.heading).map((l) => l.text),
              status: st?.stillDue ? `still due - skipped: ${st.skipReason || "no reason"}`
                : st?.lastDone ? `last ${st.lastDone}${st.lastGrade === "attested" ? " (attested)" : ""}${st.nextDue ? ` · due ${st.nextDue}` : ""}`
                : "never recorded",
            };
          })} />}
    </div>
  );
}
