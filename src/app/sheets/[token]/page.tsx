import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { instruments } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { assertSystemVisible } from "@/lib/tenancy";
import { flagOn } from "@/lib/custody/flags";
import { sheetByToken } from "@/lib/custody/sheets";
import { systemLabel } from "@/lib/systemLabel";
import SheetScan from "@/components/SheetScan";

export const dynamic = "force-dynamic";

/** Where the QR on a printed sheet lands. Sign-in applies; the token names the sheet. */
export default async function SheetPage({ params }: { params: Promise<{ token: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (!(await flagOn("custody.sheets"))) notFound();
  const { token } = await params;
  const sheet = await sheetByToken(token);
  if (!sheet) notFound();
  try { await assertSystemVisible(user, sheet.instrumentId); } catch { notFound(); }
  const [inst] = await db.select().from(instruments).where(eq(instruments.id, sheet.instrumentId));
  if (!inst) notFound();
  return (
    <div className="container page">
      <div className="crumb"><b>PM sheet</b> · {inst.externalId}</div>
      <SheetScan token={sheet.token} rows={sheet.rows} layout={sheet.layout}
        instrumentLabel={`${inst.externalId} - ${systemLabel(inst, [])}`} status={sheet.status} />
    </div>
  );
}
