import { asc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { assets, instruments, vocabTerms } from "@/db/schema";
import { MODULE_KINDS } from "@/lib/stages";
import { requireOwner } from "@/lib/authz";
import SettingsTabs from "@/components/SettingsTabs";
import CatalogForm from "@/components/CatalogForm";

export const dynamic = "force-dynamic";

/**
 * Settings > Catalog: the shop's equipment reference - system types and the
 * models each is built from. Its own section because it grows on a different
 * schedule from everything else in Settings: the instance is configured once,
 * the roster changes weekly, the catalog is curated forever.
 */
export default async function CatalogPage() {
  try { await requireOwner(); } catch { redirect("/"); }

  const [terms, assetRows, systemRows] = await Promise.all([
    db.select().from(vocabTerms).orderBy(asc(vocabTerms.assetType), asc(vocabTerms.name)),
    // Model usage, so removing one can say what it would leave behind.
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
    id: m.id, assetType: m.assetType, name: m.name, categories: m.categories,
    inUse: assetRows.filter((a) => a.kind === m.assetType && a.model.toLowerCase() === m.name.toLowerCase()).length,
  }));

  return (
    <div className="container" style={{ maxWidth: 680 }}>
      <SettingsTabs active="catalog" />
      <CatalogForm
        categories={categories}
        models={models}
        assetTypes={[...new Set([...MODULE_KINDS, ...assetRows.map((a) => a.kind)].filter(Boolean))]}
      />
    </div>
  );
}
