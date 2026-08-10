import { notFound, redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { assets, instruments } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { canSeeSystem } from "@/lib/tenancy";
import { systemLabel } from "@/lib/systemLabel";
import { getBrand } from "@/lib/brand";
import { appUrl } from "@/lib/appUrl";
import LabelCard from "@/components/LabelCard";

export const dynamic = "force-dynamic";

/** Printable label for a system: QR to its page, external id in big type. */
export default async function SystemLabelPage({ params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { id } = await params;
  const instId = parseInt(id);
  if (isNaN(instId)) notFound();
  if (!(await canSeeSystem(user, instId))) notFound();

  const [[inst], assetRows, brand] = await Promise.all([
    db.select().from(instruments).where(eq(instruments.id, instId)),
    db.select().from(assets).where(eq(assets.instrumentId, instId)).orderBy(asc(assets.sortOrder), asc(assets.id)),
    getBrand(),
  ]);
  if (!inst) notFound();

  const base = appUrl();
  return (
    <LabelCard
      url={base ? `${base}/instruments/${inst.id}` : ""}
      headline={inst.externalId}
      lines={[systemLabel(inst, assetRows), inst.client]}
      brandName={brand.operatorName}
    />
  );
}
