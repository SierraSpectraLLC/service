import { redirect } from "next/navigation";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { checkoutItems, assets, vocabTerms } from "@/db/schema";
import { MODULE_KINDS } from "@/lib/stages";
import { requireUser } from "@/lib/authz";
import CheckoutItemsPanel from "@/components/CheckoutItemsPanel";

export const dynamic = "force-dynamic";

export default async function CheckoutPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (user.role !== "owner" && user.role !== "staff") redirect("/");

  const [itemRows, assetModels, vocabModels] = await Promise.all([
    db.select().from(checkoutItems)
      .orderBy(asc(checkoutItems.assetType), asc(checkoutItems.position), asc(checkoutItems.id)),
    db.selectDistinct({ kind: assets.kind, model: assets.model }).from(assets),
    db.select().from(vocabTerms).where(eq(vocabTerms.kind, "model")),
  ]);
  // Scope options: models in the asset catalog plus models defined ahead of
  // use in Settings - so a test can target an ASI-L before one is stocked.
  // System items aren't model-scoped - a system is the sum of its assets.
  const modelOptions: Record<string, string[]> = {};
  for (const { kind, model } of assetModels) {
    if (!model) continue;
    (modelOptions[kind] ??= []).push(model);
  }
  for (const v of vocabModels) (modelOptions[v.assetType] ??= []).push(v.name);
  for (const k of Object.keys(modelOptions)) modelOptions[k] = [...new Set(modelOptions[k])].sort();

  return (
    <div className="container" style={{ maxWidth: 720 }}>
      <CheckoutItemsPanel
        assetTypes={[...new Set([...MODULE_KINDS, ...assetModels.map((a) => a.kind)].filter(Boolean))]}
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
