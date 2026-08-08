import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { assets } from "@/db/schema";

// A system is a collection of assets, so its name is composed from them:
// "LCMS-8050 + LC-40 + SIL-40". Systems recorded before assets were tracked
// fall back to the description they were created/imported with, so nothing
// goes blank while the shop fills the catalog in.

export type LabelAsset = { kind: string; model: string; sortOrder?: number };

export function composeSystemLabel(assetList: LabelAsset[], legacy = ""): string {
  const ordered = [...assetList].sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  // Two identical pumps read as "LC-40D x2" rather than repeating the model.
  const counts: { name: string; n: number }[] = [];
  for (const a of ordered) {
    const name = a.model.trim() || a.kind.trim();
    if (!name) continue;
    const seen = counts.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (seen) seen.n++;
    else counts.push({ name, n: 1 });
  }
  if (!counts.length) return legacy.trim();
  return counts.map((c) => (c.n > 1 ? `${c.name} x${c.n}` : c.name)).join(" + ");
}

/**
 * Labels for a batch of systems in one query. Pass the instrument rows you
 * already have - `model` is used only as the pre-asset fallback.
 */
export async function getSystemLabels(rows: { id: number; model: string }[]): Promise<Map<number, string>> {
  const ids = rows.map((r) => r.id);
  const assetRows = ids.length
    ? await db.select({ instrumentId: assets.instrumentId, kind: assets.kind, model: assets.model, sortOrder: assets.sortOrder })
        .from(assets).where(inArray(assets.instrumentId, ids))
    : [];
  const out = new Map<number, string>();
  for (const r of rows) {
    out.set(r.id, composeSystemLabel(assetRows.filter((a) => a.instrumentId === r.id), r.model));
  }
  return out;
}
