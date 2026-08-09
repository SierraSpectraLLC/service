import { asc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { checkoutItems, pmTemplates, vocabTerms } from "@/db/schema";
import { requireStaff } from "@/lib/authz";
import SettingsTabs from "@/components/SettingsTabs";
import CheckoutItemsPanel from "@/components/CheckoutItemsPanel";
import PmTemplatesPanel from "@/components/PmTemplatesPanel";

export const dynamic = "force-dynamic";

/**
 * Settings > Procedures: what happens to equipment, per type and model - the
 * one-time checkout tests a unit passes before it ships, and the recurring
 * maintenance it needs forever after. Both key on the Catalog tab's types and
 * models; neither accepts a type or model the catalog doesn't know.
 */
export default async function ProceduresPage() {
  let user;
  try { user = await requireStaff(); } catch { redirect("/"); }

  const [itemRows, templates, terms] = await Promise.all([
    db.select().from(checkoutItems)
      .orderBy(asc(checkoutItems.assetType), asc(checkoutItems.position), asc(checkoutItems.id)),
    db.select().from(pmTemplates).orderBy(asc(pmTemplates.assetType), asc(pmTemplates.title)),
    db.select().from(vocabTerms).orderBy(asc(vocabTerms.name)),
  ]);

  // Types and models come from the catalog alone - the point of having one.
  const assetTypes = terms.filter((t) => t.kind === "asset_type").map((t) => t.name);
  const modelOptions: Record<string, string[]> = {};
  for (const t of terms) {
    if (t.kind !== "model" || !t.assetType) continue;
    (modelOptions[t.assetType] ??= []).push(t.name);
  }

  return (
    <div className="container" style={{ maxWidth: 720 }}>
      <SettingsTabs active="procedures" isOwner={user.role === "owner"} />
      <CheckoutItemsPanel
        assetTypes={assetTypes}
        items={itemRows.map((i) => ({
          id: i.id, assetType: i.assetType, kind: i.kind, name: i.name, position: i.position,
          resultType: i.resultType, target: i.target, tolerancePct: i.tolerancePct,
          requiresNote: i.requiresNote, consumesPart: i.consumesPart, modelScope: i.modelScope,
        }))}
        modelOptions={modelOptions}
      />
      <PmTemplatesPanel templates={templates} assetTypes={assetTypes} modelOptions={modelOptions} />
    </div>
  );
}
