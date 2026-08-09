import { notFound, redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { assets } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import { assetAccess } from "@/lib/tenancy";
import { getBrand } from "@/lib/brand";
import { appUrl } from "@/lib/appUrl";
import LabelCard from "@/components/LabelCard";

export const dynamic = "force-dynamic";

/** Printable label for one unit: QR to its page, serial in big type. */
export default async function AssetLabelPage({ params }: { params: Promise<{ id: string }> }) {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  const { id } = await params;
  const assetId = parseInt(id);
  if (isNaN(assetId)) notFound();
  if (!(await assetAccess(user, assetId)).see) notFound();

  const [[asset], brand] = await Promise.all([
    db.select().from(assets).where(eq(assets.id, assetId)),
    getBrand(),
  ]);
  if (!asset) notFound();

  const base = appUrl();
  return (
    <LabelCard
      url={base ? `${base}/assets/${asset.id}` : ""}
      headline={asset.serial ? `SN ${asset.serial}` : asset.kind}
      lines={[
        `${asset.kind}${asset.model ? ` — ${asset.model}` : ""}`,
        asset.manufacturer,
      ]}
      brandName={brand.operatorName}
    />
  );
}
