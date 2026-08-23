import { asc } from "drizzle-orm";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { assets, catalogRefs, instruments, vocabTerms } from "@/db/schema";
import { requireStaff } from "@/lib/authz";
import { isPlatformStaff, tenantViewer } from "@/lib/tenants";
import { forTenant, readTenant } from "@/lib/tenancy";
import CatalogForm from "@/components/CatalogForm";
import MakersCard from "@/components/MakersCard";
import PendingModelsCard from "@/components/PendingModelsCard";
import { makerBook } from "@/lib/makersData";
import CatalogPhotosCard from "@/components/CatalogPhotosCard";
import ReferencePanel from "@/components/ReferencePanel";
import CatalogGasCard from "@/components/CatalogGasCard";
import CatalogPackageCard from "@/components/CatalogPackageCard";
import { shopDay } from "@/lib/shopday";

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
  const isPlatform = isPlatformStaff(tenantViewer(user));

  const [terms, assetRows, systemRows] = await Promise.all([
    db.select().from(vocabTerms).where(forTenant(vocabTerms.tenantOrgId, readTenant(user)))
      .orderBy(asc(vocabTerms.assetType), asc(vocabTerms.name)),
    // Usage counts, so removing something can say what it would leave behind.
    db.select({ kind: assets.kind, model: assets.model }).from(assets)
      .where(forTenant(assets.tenantOrgId, readTenant(user))),
    db.select({ category: instruments.category }).from(instruments)
      .where(forTenant(instruments.tenantOrgId, readTenant(user))),
  ]);
  // The maker/vendor book: defined names plus every spelling in use, with counts.
  const makerRows = await makerBook(readTenant(user));
  const refRows = await db.select().from(catalogRefs)
    .where(forTenant(catalogRefs.tenantOrgId, readTenant(user)))
    .orderBy(asc(catalogRefs.assetType), asc(catalogRefs.model), asc(catalogRefs.id)).catch(() => []);

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
    hasPhoto: !!m.photoUrl,
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

  // Freehand models: on real units, unknown to the book. The review queue -
  // sits above the catalog because it is the catalog's inbox.
  const pendingModels = Object.values(
    assetRows.reduce<Record<string, { kind: string; model: string; count: number }>>((acc, a) => {
      const model = a.model.trim();
      if (!model) return acc;
      if (models.some((m) => m.name.toLowerCase() === model.toLowerCase()
        && m.assetType.toLowerCase() === a.kind.trim().toLowerCase())) return acc;
      const k = `${a.kind.toLowerCase()}|${model.toLowerCase()}`;
      acc[k] = acc[k] ? { ...acc[k], count: acc[k].count + 1 } : { kind: a.kind, model, count: 1 };
      return acc;
    }, {}),
  ).sort((a, b) => a.model.localeCompare(b.model));
  const modelsByTypeName: Record<string, string[]> = {};
  for (const m of models) (modelsByTypeName[m.assetType] ??= []).push(m.name);

  return (
    <div>
      <PendingModelsCard pending={pendingModels} modelOptions={modelsByTypeName} makers={makerRows.map((m) => m.name)} />
      <CatalogForm categories={categories} models={models} types={types} makers={makerRows.map((m) => m.name)} />
      <MakersCard makers={makerRows} />
      <CatalogPhotosCard entries={terms.map((t) => ({
        id: t.id, kind: t.kind, assetType: t.assetType, name: t.name, manufacturer: t.manufacturer,
        // The URL itself never reaches the browser: the photo is fetched through
        // /api/catalog/photo, which checks who is asking.
        hasPhoto: !!t.photoUrl, photoFraming: t.photoFraming,
      }))} />
      <CatalogGasCard entries={terms.map((t) => ({
        id: t.id, kind: t.kind, assetType: t.assetType, name: t.name, gases: t.gases,
      }))} />
      <CatalogPackageCard entries={terms.map((t) => ({
        id: t.id, kind: t.kind, assetType: t.assetType, name: t.name, docTypes: t.docTypes,
      }))} />
      <ReferencePanel canEdit
        sub="Reference material per model or module type."
        scopes={[
          ...models.map((m) => ({ assetType: m.assetType, model: m.name, label: `${m.name} (${m.assetType})` })),
          ...types.filter((t) => t.id !== null).map((t) => ({ assetType: t.name, model: "", label: `any ${t.name.toLowerCase()}` })),
        ]}
        refs={refRows.map((r) => ({
          id: r.id, assetType: r.assetType, model: r.model, kind: r.kind,
          title: r.title, url: r.url, body: r.body, createdBy: r.createdBy,
          provenance: r.provenance,
          when: shopDay(r.createdAt),
        }))} />
    </div>
  );
}
