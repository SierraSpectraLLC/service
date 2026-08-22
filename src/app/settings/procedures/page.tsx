import { asc } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { procedures, vocabTerms } from "@/db/schema";
import { requireStaff } from "@/lib/authz";
import { isPlatformStaff, tenantViewer } from "@/lib/tenants";
import { parseProcParts } from "@/lib/procedures";
import { forTenant, readTenant } from "@/lib/tenancy";
import ProceduresPanel from "@/components/ProceduresPanel";

export const dynamic = "force-dynamic";

/**
 * Settings > Procedures: one catalog of what gets done to equipment, per
 * module type and model. WHEN a procedure fires - once at intake, on a
 * cadence, or both - is a property of the row, not a separate page. Types and
 * models come from the Catalog tab; nothing here accepts free text.
 */
export default async function ProceduresPage() {
  let user;
  try { user = await requireStaff(); } catch { redirect("/"); }
  const isPlatform = isPlatformStaff(tenantViewer(user));

  const [rows, terms] = await Promise.all([
    db.select().from(procedures).where(forTenant(procedures.tenantOrgId, readTenant(user)))
      .orderBy(asc(procedures.assetType), asc(procedures.position), asc(procedures.id)),
    db.select().from(vocabTerms).where(forTenant(vocabTerms.tenantOrgId, readTenant(user)))
      .orderBy(asc(vocabTerms.name)),
  ]);

  const assetTypes = terms.filter((t) => t.kind === "asset_type").map((t) => t.name);
  const modelOptions: Record<string, string[]> = {};
  // Which system categories each module type turns up in, taken from the models
  // in the catalog - the same derivation the Catalog tab makes, so both pages
  // group equipment the same way instead of two orders of the same fleet.
  const categoriesByType: Record<string, string[]> = {};
  // Which of a type's models are filed under which system type - the scope
  // ladder's "Autosamplers on LC-MS: 3 models" counts.
  const modelsByCategory: Record<string, Record<string, string[]>> = {};
  for (const t of terms) {
    if (t.kind !== "model" || !t.assetType) continue;
    (modelOptions[t.assetType] ??= []).push(t.name);
    for (const c of t.categories) {
      const seen = (categoriesByType[t.assetType] ??= []);
      if (!seen.includes(c)) seen.push(c);
      ((modelsByCategory[t.assetType] ??= {})[c] ??= []).push(t.name);
    }
  }
  const categories = terms.filter((t) => t.kind === "category").map((t) => t.name);

  return (
    <div>
      <ProceduresPanel
        assetTypes={assetTypes}
        modelOptions={modelOptions}
        modelsByCategory={modelsByCategory}
        categories={categories}
        categoriesByType={categoriesByType}
        items={rows.map((r) => ({
          id: r.id, assetType: r.assetType, kind: r.kind, name: r.name, notes: r.notes, position: r.position,
          resultType: r.resultType, target: r.target, tolerancePct: r.tolerancePct,
          acceptance: r.acceptance,
          requiresNote: r.requiresNote, consumesPart: r.consumesPart,
          runsAtIntake: r.runsAtIntake, intervalDays: r.intervalDays, required: r.required,
          needsReport: r.needsReport,
          usageEvery: r.usageEvery, usageUnit: r.usageUnit,
          qualification: r.qualification,
          categoryScope: r.categoryScope,
          parts: parseProcParts(r.parts), modelScope: r.modelScope, checklist: r.checklist,
          provenance: r.provenance,
        }))}
      />
    </div>
  );
}
