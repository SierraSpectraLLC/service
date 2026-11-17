// The family sheets, read from the database - the server half of
// lib/modelSpecs, which stays pure. One query for a workspace's families, then
// a lookup per model, because the pages that show specs (a system with eight
// modules, a catalog model with its siblings) would otherwise ask once per row.
import { db } from "@/db";
import { catalogSeries } from "@/db/schema";
import { forTenant } from "@/lib/tenancy";
import { effectiveSpecs, parseModelSpecs, type Spec } from "@/lib/modelSpecs";

export type SeriesSheet = { id: number; assetType: string; name: string; specs: Spec[] };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Every family sheet in a workspace. Null tenant = no restriction. */
export async function loadSeriesSheets(tenantOrgId: number | null): Promise<SeriesSheet[]> {
  const rows = await db.select().from(catalogSeries)
    .where(forTenant(catalogSeries.tenantOrgId, tenantOrgId))
    .catch(() => []);
  return rows.map((r) => ({ id: r.id, assetType: r.assetType, name: r.name, specs: parseModelSpecs(r.specs) }));
}

/**
 * The sheet a family holds, or an empty one: a family exists as soon as a
 * model names it (vocab_terms.series), and has a row here only once somebody
 * wrote on it. Matched the way catalog_refs.series is - by name, within the
 * module type, case-insensitively.
 */
export function seriesSpecsFor(sheets: SeriesSheet[], assetType: string, series: string): Spec[] {
  if (!series.trim()) return [];
  return sheets.find((s) => same(s.assetType, assetType) && same(s.name, series))?.specs ?? [];
}

/** A model's merged sheet - its own rows over its family's. See lib/modelSpecs.effectiveSheet. */
export function specsForTerm(
  term: { assetType: string; series: string; specs: string }, sheets: SeriesSheet[],
): Spec[] {
  return effectiveSpecs(parseModelSpecs(term.specs), seriesSpecsFor(sheets, term.assetType, term.series));
}
