import { redirect } from "next/navigation";
import { asc, inArray } from "drizzle-orm";
import { db } from "@/db";
import { taskTemplates, templateTasks, templateItems, checkoutItems, assets, instruments } from "@/db/schema";
import { requireUser } from "@/lib/authz";
import TemplatesPanel from "@/components/TemplatesPanel";
import CheckoutItemsPanel from "@/components/CheckoutItemsPanel";

export const dynamic = "force-dynamic";

export default async function TemplatesPage() {
  let user;
  try { user = await requireUser(); } catch { redirect("/login"); }
  if (user.role !== "owner" && user.role !== "staff") redirect("/");

  const [tpls, itemRows, assetModels, systemModels] = await Promise.all([
    db.select().from(taskTemplates).orderBy(asc(taskTemplates.name)),
    db.select().from(checkoutItems)
      .orderBy(asc(checkoutItems.assetType), asc(checkoutItems.position), asc(checkoutItems.id)),
    db.selectDistinct({ kind: assets.kind, model: assets.model }).from(assets),
    db.selectDistinct({ model: instruments.model }).from(instruments),
  ]);
  const tplIds = tpls.map((t) => t.id);
  const tTasks = tplIds.length
    ? await db.select().from(templateTasks).where(inArray(templateTasks.templateId, tplIds))
      .orderBy(asc(templateTasks.sortOrder), asc(templateTasks.id))
    : [];
  const taskIds = tTasks.map((t) => t.id);
  const tItems = taskIds.length
    ? await db.select().from(templateItems).where(inArray(templateItems.templateTaskId, taskIds))
      .orderBy(asc(templateItems.sortOrder), asc(templateItems.id))
    : [];

  const templates = tpls.map((t) => ({
    id: t.id,
    name: t.name,
    tasks: tTasks.filter((x) => x.templateId === t.id).map((x) => ({
      id: x.id, title: x.title, body: x.body,
      items: tItems.filter((i) => i.templateTaskId === x.id).map((i) => ({ id: i.id, text: i.text })),
    })),
  }));

  // Scope options come from the catalog only: distinct asset models per type,
  // distinct instrument models for the System group.
  const modelOptions: Record<string, string[]> = {
    system: [...new Set(systemModels.map((m) => m.model).filter(Boolean))].sort(),
  };
  for (const { kind, model } of assetModels) {
    if (!model) continue;
    (modelOptions[kind] ??= []).push(model);
  }
  for (const k of Object.keys(modelOptions)) modelOptions[k] = [...new Set(modelOptions[k])].sort();

  return (
    <div className="container" style={{ maxWidth: 720 }}>
      <TemplatesPanel templates={templates} />
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
