import { asc } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { assets, instruments, vocabTerms } from "@/db/schema";
import { requireStaff } from "@/lib/authz";
import SettingsTabs from "@/components/SettingsTabs";
import CatalogForm from "@/components/CatalogForm";

export const dynamic = "force-dynamic";

/**
 * Settings > Catalog: the shop's equipment reference - system types, module
 * types, and the models each is built from. The ONLY place any of those is
 * defined: every picker in the app reads from here, none accepts free text.
 * House-curated (owner and staff), shared by everyone signed in.
 */
export default async function CatalogPage() {
  let user;
  try { user = await requireStaff(); } catch { redirect("/"); }

  const [terms, assetRows, systemRows] = await Promise.all([
    db.select().from(vocabTerms).orderBy(asc(vocabTerms.assetType), asc(vocabTerms.name)),
    // Usage counts, so removing something can say what it would leave behind.
    db.select({ kind: assets.kind, model: assets.model }).from(assets),
    db.select({ category: instruments.category }).from(instruments),
  ]);

  const defined = terms.filter((t) => t.kind === "category");
  // A category can exist only on systems - typed in before anyone defined it.
  // Show those too, so the page reflects the shop rather than the vocabulary.
  const undefinedCats = [...new Set(systemRows.map((s) => s.category).filter(Boolean))]
    .filter((name) => !defined.some((d) => d.name.toLowerCase() === name.toLowerCase()));

  const categories = [
    ...defined.map((c) => ({
      id: c.id as number | null, name: c.name,
      systems: systemRows.filter((s) => s.category.toLowerCase() === c.name.toLowerCase()).length,
    })),
    ...undefinedCats.map((name) => ({
      id: null, name,
      systems: systemRows.filter((s) => s.category === name).length,
    })),
  ].sort((a, b) => a.name.localeCompare(b.name));

  const models = terms.filter((t) => t.kind === "model").map((m) => ({
    id: m.id, assetType: m.assetType, name: m.name, categories: m.categories, manufacturer: m.manufacturer,
    inUse: assetRows.filter((a) => a.kind === m.assetType && a.model.toLowerCase() === m.name.toLowerCase()).length,
  }));

  // Module types: the catalog's list, plus any kind that exists only on units
  // (recorded before the catalog took over) so the page shows the whole shop.
  const definedTypes = terms.filter((t) => t.kind === "asset_type");
  const strayKinds = [...new Set(assetRows.map((a) => a.kind).filter(Boolean))]
    .filter((k) => !definedTypes.some((t) => t.name.toLowerCase() === k.toLowerCase()));
  const types = [
    ...definedTypes.map((t) => ({
      id: t.id as number | null, name: t.name,
      models: models.filter((m) => m.assetType.toLowerCase() === t.name.toLowerCase()).length,
      inUse: assetRows.filter((a) => a.kind.toLowerCase() === t.name.toLowerCase()).length,
    })),
    ...strayKinds.map((name) => ({
      id: null, name,
      models: 0,
      inUse: assetRows.filter((a) => a.kind === name).length,
    })),
  ].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="container page">
      <SettingsTabs active="catalog" isOwner={user.role === "owner"} />
      <CatalogForm categories={categories} models={models} types={types} />
    </div>
  );
}
