import { redirect } from "next/navigation";
import { asc } from "drizzle-orm";
import { db } from "@/db";
import { checkoutItems, assets } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import CheckoutItemsPanel from "@/components/CheckoutItemsPanel";

export const dynamic = "force-dynamic";

export default async function CheckoutPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (user.role !== "owner" && user.role !== "staff") redirect("/");

  const [itemRows, assetModels] = await Promise.all([
    db.select().from(checkoutItems)
      .orderBy(asc(checkoutItems.assetType), asc(checkoutItems.position), asc(checkoutItems.id)),
    db.selectDistinct({ kind: assets.kind, model: assets.model }).from(assets),
  ]);
  // Scope options come from the catalog only: the distinct models recorded for
  // each asset type. System items aren't model-scoped - a system has no model
  // of its own, it's the sum of its assets.
  const modelOptions: Record<string, string[]> = {};
  for (const { kind, model } of assetModels) {
    if (!model) continue;
    (modelOptions[kind] ??= []).push(model);
  }
  for (const k of Object.keys(modelOptions)) modelOptions[k] = [...new Set(modelOptions[k])].sort();

  return (
    <div className="container" style={{ maxWidth: 720 }}>
      <CheckoutItemsPanel
        items={itemRows.map((i) => ({
          id: i.id, assetType: i.assetType, kind: i.kind, name: i.name, position: i.position,
          resultType: i.resultType, target: i.target, tolerancePct: i.tolerancePct,
          requiresNote: i.requiresNote, consumesPart: i.consumesPart, modelScope: i.modelScope,
        }))}
        modelOptions={modelOptions}
      />
    </div>
  );
}
