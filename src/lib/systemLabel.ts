import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { assets } from "@/db/schema";

// What a system is called, in priority order:
//   1. the name someone chose for it (instruments.name) - always wins;
//   2. composed from its assets: "LCMS-8050 + LC-40 + SIL-40";
//   3. the legacy description it was created or imported with.
//
// Composing is right for a two-box system and useless once seven LC modules add
// up to a paragraph, which is why a chosen name overrides rather than seeds it:
// nothing you type is ever recomputed away.

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
 * already have; `name` wins when set and `model` is the pre-asset fallback.
 * Rows without a `name` field still work - older call sites just get the
 * composed label.
 */
export async function getSystemLabels(rows: { id: number; model: string; name?: string }[]): Promise<Map<number, string>> {
  const ids = rows.map((r) => r.id);
  const assetRows = ids.length
    ? await db.select({ instrumentId: assets.instrumentId, kind: assets.kind, model: assets.model, sortOrder: assets.sortOrder })
        .from(assets).where(inArray(assets.instrumentId, ids))
    : [];
  const out = new Map<number, string>();
  for (const r of rows) {
    const chosen = (r.name ?? "").trim();
    out.set(r.id, chosen || composeSystemLabel(assetRows.filter((a) => a.instrumentId === r.id), r.model));
  }
  return out;
}

/** One system's label: the chosen name if there is one, else composed. */
export const systemLabel = (
  inst: { name?: string; model: string },
  assetList: LabelAsset[],
): string => (inst.name ?? "").trim() || composeSystemLabel(assetList, inst.model);
