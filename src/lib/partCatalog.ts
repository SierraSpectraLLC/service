// What a part number IS.
//
// Everywhere else in this system a part number is a bare string: on a part
// fitted to a machine, on a shelf line, on a PO line, in the price book, in the
// parts list of a procedure. normalizePn was the only thing making those five
// agree, and nothing anywhere said that AGI-7167-PMK is the Agilent 7176 PM kit.
// So the same number got a different name typed against it every time somebody
// used it, and a kit had no way to state what was in it.
//
// This module is the lookup those five were missing. What it deliberately is NOT
// is a foreign key: nothing here can prevent a part being recorded. A part
// fitted at 2am by somebody holding a box with a number on it must land in the
// record whether or not the shop has catalogued it - so every function takes the
// catalog and a number, and shrugs politely when the number is unknown.

import { sellPrice } from "@/lib/billing";
import { normalizePn } from "@/lib/priceBook";

export const PART_KINDS = ["part", "consumable", "kit"] as const;
export type PartKind = (typeof PART_KINDS)[number];

/**
 * The kinds that are not things: an hour and a trip.
 *
 * A shop quotes "LABOR-LCP" and "TZ3O" the way it quotes a seal - off a number
 * with an agreed price behind it - and before this the only place those could
 * live was the free-text description of a line, retyped and re-priced every
 * time somebody built a quote. They are catalog rows because that is what a
 * number IS here: one row saying what it means and what it costs.
 *
 * They are deliberately NOT stocked, ordered or fitted. Nothing counts them on
 * a shelf and no purchase order may quote one, which is why every part picker
 * takes a `kinds` list and the default excludes these two.
 */
export const SERVICE_KINDS = ["labor", "travel"] as const;
export type ServiceKind = (typeof SERVICE_KINDS)[number];

/** Everything the catalog can hold - things and the hours that fit them. */
export const CATALOG_KINDS = [...PART_KINDS, ...SERVICE_KINDS] as const;

export const PART_KIND_LABEL: Record<string, string> = {
  part: "Part",
  consumable: "Consumable",
  kit: "Kit",
  labor: "Labor",
  travel: "Travel",
};

/** An hour or a trip rather than a thing in a box. */
export const isService = (kind: string): boolean =>
  (SERVICE_KINDS as readonly string[]).includes(kind);

/**
 * The invoice/quote line kind this catalog row bills as.
 *
 * A service code carries its own kind - labor bills as labor, travel as travel
 * - and everything else is a part, consumables and kits included: those are
 * things sold, and "consumable" is a stocking fact rather than a billing one.
 */
export const lineKindFor = (kind: string): string => (isService(kind) ? kind : "part");

/**
 * What one of it is. "h" for an hour of labor, "trip" for a zone charge, "" for
 * a thing you count.
 *
 * Free text with suggestions rather than an enum: a shop that bills travel by
 * the day, the mile or the leg is not wrong, and refusing the word it uses
 * would only push it back into the description.
 */
export const UNIT_SUGGESTIONS = ["h", "trip", "day", "mile", "ea"] as const;

/** The unit a code bills in, falling back to the one its kind usually uses. */
export const unitFor = (e: { kind: string; unit?: string }): string =>
  (e.unit ?? "").trim() || (isService(e.kind) ? "h" : "");

export type CatalogEntry = {
  id: number;
  partNumber: string;
  name: string;
  manufacturer: string;
  mfrPartNumber: string;
  kind: string;
  archived: boolean;
  /**
   * Every OTHER number this same part answers to - our second number, the
   * maker's, the third party's. Optional so a caller that has not loaded them
   * behaves exactly as it did before they existed.
   */
  aliases?: PartAlias[];
  /**
   * What a SERVICE code is billed at, per unit. Meaningless on a thing in a
   * box, whose price is the price book plus the shop's markup - see
   * quotedUnitCents, which is the one place that distinction is made.
   */
  rateCents?: number;
  /** What one of it is: "h", "trip", "day". See unitFor. */
  unit?: string;
};

/**
 * One of a part's other numbers.
 *
 * `kind` is 'shop' (another of ours), 'oem' (somebody else's for the same
 * thing), or 'superseded' - a number that IS this part but is no longer the one
 * to buy. The third is the one that carries weight: a superseded number must
 * still resolve, because it is on every record and every invoice from before
 * the maker changed it, and it must never be the number the software goes and
 * orders. Recording it as a note said the first half and did nothing about the
 * second.
 */
export type PartAlias = { kind: string; partNumber: string; manufacturer?: string; note?: string };

export const ALIAS_KINDS = ["shop", "oem", "superseded"] as const;
export const ALIAS_KIND_LABEL: Record<string, string> = {
  shop: "Ours", oem: "Maker's", superseded: "Superseded",
};

/** True when this number is history: it still looks up, it never gets ordered. */
export const isSuperseded = (a: Pick<PartAlias, "kind">) => a.kind === "superseded";

/**
 * Every number that identifies this part, normalized, primaries first.
 *
 * The whole point of the alias table: matching a number in somebody's hand has
 * to consider all of them, and forgetting one somewhere means the same part
 * shows up described on one screen and undescribed on the next.
 */
export function allNumbers(e: Pick<CatalogEntry, "partNumber" | "mfrPartNumber" | "aliases">): string[] {
  const out: string[] = [];
  for (const n of [e.partNumber, e.mfrPartNumber, ...(e.aliases ?? []).map((a) => a.partNumber)]) {
    const pn = normalizePn(n ?? "");
    if (pn && !out.includes(pn)) out.push(pn);
  }
  return out;
}

/**
 * The catalog row for a number, matched the way the rest of the system matches
 * part numbers (lib/priceBook): lowercased with spaces stripped, and hyphens
 * KEPT - "5181-3323" and "51813-323" are different parts, and folding the
 * punctuation would quietly merge two of them.
 *
 * Archived entries still resolve. A part that was retired last year is still
 * what was fitted in March, and a history that suddenly forgot its name would be
 * worse than one that never knew it.
 */
export function catalogEntry<T extends CatalogEntry>(catalog: T[], partNumber: string): T | null {
  const pn = normalizePn(partNumber);
  if (!pn) return null;
  // Any of its numbers, not just the one on the row. A seal bought as the
  // maker's number and fitted under ours is one part, and resolving only the
  // primary is how it became two.
  const hits = catalog.filter((c) => allNumbers(c).includes(pn));
  // A live entry beats an archived one when both spellings exist, which is what
  // superseding a number by re-cataloguing it looks like.
  return hits.find((c) => !c.archived) ?? hits[0] ?? null;
}

/** The name the catalog knows for a number, or whatever the caller already had. */
export const catalogName = (catalog: CatalogEntry[], partNumber: string, fallback = ""): string =>
  catalogEntry(catalog, partNumber)?.name || fallback;

/** "AGI-7167-PMK - Agilent 7176 PM Kit", for a picker or a chip. */
export function catalogLabel(e: Pick<CatalogEntry, "partNumber" | "name" | "manufacturer">): string {
  const bits = [e.partNumber.trim(), e.name.trim()].filter(Boolean);
  const head = bits.join(" - ");
  return e.manufacturer.trim() ? `${head} (${e.manufacturer.trim()})` : head;
}

/**
 * Catalog rows matching what somebody has typed into a picker.
 *
 * Searches all four identifying fields, because the number in somebody's hand is
 * as often the manufacturer's as it is ours - the whole reason a house number
 * exists is that it wraps somebody else's.
 */
export function searchCatalog<T extends CatalogEntry>(
  catalog: T[], query: string, limit = 20, kinds?: readonly string[],
): T[] {
  // Which half of the book this picker is for. A purchase order may not quote
  // an hour and a quote line may quote anything, so the caller says - and a
  // caller that does not care sees the whole book, as every one of them did
  // before service codes existed.
  if (kinds) catalog = catalog.filter((c) => kinds.includes(c.kind));
  const q = query.trim().toLowerCase();
  if (!q) return catalog.filter((c) => !c.archived).slice(0, limit);
  const pn = normalizePn(query);
  const hit = (c: T) =>
    (pn.length > 0 && normalizePn(c.partNumber).includes(pn))
    || (pn.length > 0 && normalizePn(c.mfrPartNumber).includes(pn))
    || (pn.length > 0 && (c.aliases ?? []).some((a) => normalizePn(a.partNumber).includes(pn)))
    || c.name.toLowerCase().includes(q)
    || c.manufacturer.toLowerCase().includes(q)
    || (c.aliases ?? []).some((a) => (a.manufacturer ?? "").toLowerCase().includes(q));
  // Live entries first: an archived part is usually not what somebody picking
  // from a list wants, but it is occasionally exactly what they want.
  const live = catalog.filter((c) => !c.archived && hit(c));
  const gone = catalog.filter((c) => c.archived && hit(c));
  return [...live, ...gone].slice(0, limit);
}

/**
 * What one of these is quoted at, in cents.
 *
 * The two halves of the book price differently and only this function knows
 * that. A THING is the price book plus the shop's markup - the same
 * lib/billing.sellPrice an invoice bills a fitted part with, so a quote and
 * the bill that follows it cannot disagree. A SERVICE CODE is its own rate,
 * because there is no vendor and no cost: what an hour of LC/MS work sells for
 * is a decision, not a purchase.
 *
 * Zero when nobody has said - an uncosted part and a rateless code both quote
 * at nothing, which is a question somebody answers before the quote goes out.
 * An invented price is one nobody notices.
 */
export function quotedUnitCents(
  e: { kind: string; rateCents?: number; priceCents?: number | null },
  partsMarkupBps = 0,
): number {
  if (isService(e.kind)) return Math.max(0, Math.round(e.rateCents ?? 0));
  return sellPrice(e.priceCents ?? null, partsMarkupBps);
}

export type KitLine = { partNumber: string; name: string; qty: number };

/**
 * What is in a kit, as the lines a person reads.
 *
 * A kit is stocked, ordered and issued as ONE thing - the count on the shelf is
 * a count of sealed kits, and exploding it into its contents when it is issued
 * would make the inventory claim eleven ferrules are on a shelf when what is
 * actually there is one bag nobody has opened. So this is for showing, and the
 * quantities are what the bag contains rather than anything the ledger tracks.
 */
export function kitContents(lines: KitLine[]): string {
  return lines
    .filter((l) => l.partNumber.trim() || l.name.trim())
    .map((l) => `${l.qty > 1 ? `${l.qty}x ` : ""}${l.name.trim() || l.partNumber.trim()}`)
    .join(", ");
}

/**
 * Is this catalogued at all?
 *
 * Used to show the one thing worth showing next to a part number nobody has
 * described: an offer to describe it. Everything still works uncatalogued, which
 * is why this is a hint and never a validation error.
 */
export const isCatalogued = (catalog: CatalogEntry[], partNumber: string): boolean =>
  catalogEntry(catalog, partNumber) !== null;

/**
 * A part number seen on real work, with whatever that work already knows about
 * it. A number fitted at 2am arrives bare; the same number typed onto a PM
 * procedure arrives with its name, its module type and its models - the whole
 * TOC-VW consumables list, ready to describe in one click each.
 */
export type UsedPart = {
  partNumber: string;
  name?: string;
  assetType?: string;
  models?: string[];
  /** Where it was seen - "maintenance", "fitted", "stock", "purchasing". */
  source?: string;
};

export type UncataloguedPart = {
  partNumber: string;
  name: string;
  assetTypes: string[];
  models: string[];
  sources: string[];
};

/**
 * Part numbers used in the shop that the catalog has never heard of.
 *
 * The list that makes cataloguing tractable: rather than asking somebody to type
 * out their whole parts catalog, show them the numbers they have actually used and
 * let them name those. Deduplicated the way part numbers dedupe, with the first
 * spelling kept - the catalog should be seeded with what people really type -
 * and enriched across sources: the name comes from whichever mention had one.
 */
export function uncatalogued(catalog: CatalogEntry[], used: (string | UsedPart)[]): UncataloguedPart[] {
  // Every number of every entry, or a part described under the maker's number
  // would keep appearing here as one nobody has described.
  const known = new Set(catalog.flatMap(allNumbers));
  const out = new Map<string, UncataloguedPart>();
  for (const raw of used) {
    const u: UsedPart = typeof raw === "string" ? { partNumber: raw } : raw;
    const pn = normalizePn(u.partNumber);
    if (!pn || known.has(pn)) continue;
    const cur = out.get(pn) ?? { partNumber: u.partNumber.trim(), name: "", assetTypes: [], models: [], sources: [] };
    if (!cur.name && u.name?.trim()) cur.name = u.name.trim();
    if (u.assetType?.trim() && !cur.assetTypes.includes(u.assetType.trim())) cur.assetTypes.push(u.assetType.trim());
    for (const m of u.models ?? []) {
      if (m.trim() && !cur.models.some((x) => x.toLowerCase() === m.trim().toLowerCase())) cur.models.push(m.trim());
    }
    if (u.source && !cur.sources.includes(u.source)) cur.sources.push(u.source);
    out.set(pn, cur);
  }
  return [...out.values()].sort((a, b) => a.partNumber.localeCompare(b.partNumber, undefined, { sensitivity: "base" }));
}

/**
 * Clean a typed list of extra numbers: trimmed, bounded, and de-duplicated
 * against each other AND against the entry's own primaries.
 *
 * Re-listing the primary as an alias is the commonest slip (you paste the whole
 * row in), and it would make the same string appear twice on the chip line.
 */
export function cleanAliases(
  list: PartAlias[], primaries: { partNumber: string; mfrPartNumber: string },
): PartAlias[] {
  const seen = new Set([normalizePn(primaries.partNumber), normalizePn(primaries.mfrPartNumber)].filter(Boolean));
  const out: PartAlias[] = [];
  for (const a of list.slice(0, 30)) {
    const partNumber = (a.partNumber ?? "").trim().slice(0, 80);
    const pn = normalizePn(partNumber);
    if (!pn || seen.has(pn)) continue;
    seen.add(pn);
    out.push({
      kind: (ALIAS_KINDS as readonly string[]).includes(a.kind) ? a.kind : "oem",
      partNumber,
      manufacturer: (a.manufacturer ?? "").trim().slice(0, 80),
      note: (a.note ?? "").trim().slice(0, 120),
    });
  }
  return out;
}

/**
 * Which OTHER catalog entry already claims one of these numbers, if any.
 *
 * Two entries answering to one number is the failure this table can create:
 * catalogEntry would resolve it to whichever came first, so the same box would
 * describe itself differently depending on the screen. Caught at save time
 * instead, naming the number and the entry that has it.
 */
export function numberClash<T extends CatalogEntry>(
  others: T[], numbers: { partNumber: string; mfrPartNumber: string; aliases?: PartAlias[] },
): { number: string; entry: T } | null {
  const mine = allNumbers(numbers);
  for (const pn of mine) {
    const hit = others.find((o) => allNumbers(o).includes(pn));
    if (hit) return { number: pn, entry: hit };
  }
  return null;
}

/**
 * How many photos one part keeps. A cap rather than none: this is a catalog
 * row, shown inline wherever the number appears, and thirty photos of a seal
 * is a gallery nobody scrolls.
 */
export const MAX_PART_PHOTOS = 8;

/**
 * What should actually be bought when somebody quotes this number.
 *
 * The whole point of recording a superseded number: it stays look-up-able
 * forever, and the answer to "order me one of these" is the number that
 * replaced it. Returns null when the number is unknown or already current, so
 * the caller's ordinary path is untouched and only the interesting case costs
 * anything.
 *
 * The replacement is the entry's OWN number - its primary, which is by
 * definition the one it is called now. A part whose primary is itself marked
 * superseded is a contradiction somebody typed; treated as current, because
 * refusing to name any number would be worse than naming the one on the row.
 */
export function currentNumber<T extends CatalogEntry>(
  catalog: T[], partNumber: string,
): { quoted: string; current: string; entry: T } | null {
  const pn = normalizePn(partNumber);
  if (!pn) return null;
  const entry = catalogEntry(catalog, partNumber);
  if (!entry) return null;
  const hit = (entry.aliases ?? []).find((a) => isSuperseded(a) && normalizePn(a.partNumber) === pn);
  if (!hit) return null;
  const current = entry.partNumber.trim();
  if (!current || normalizePn(current) === pn) return null;
  return { quoted: partNumber.trim(), current, entry };
}

/** The numbers this part is still sold under - everything except its history. */
export function liveNumbers(e: Pick<CatalogEntry, "partNumber" | "mfrPartNumber" | "aliases">): string[] {
  const dead = new Set((e.aliases ?? []).filter(isSuperseded).map((a) => normalizePn(a.partNumber)));
  return allNumbers(e).filter((n) => !dead.has(n));
}

/**
 * One catalog row as a completion: what it says, and why it matched.
 *
 * `matchedOn` is the part that earns this its place in a dropdown. Typing an
 * old number and being offered the current one is only useful if the row SAYS
 * that is what happened - otherwise it looks like the wrong suggestion.
 */
export type PartSuggestion<T extends CatalogEntry = CatalogEntry> = {
  entry: T;
  /** The number to insert. Always the entry's current one. */
  partNumber: string;
  name: string;
  /** "was 062-65005-00" when the query hit a superseded number, else "". */
  wasQuoted: string;
  /** The alias the query hit, when it was neither the primary nor the name. */
  alsoKnownAs: string;
};

/**
 * Completions for a part-number field: number fragments, maker's numbers,
 * superseded numbers, and plain description.
 *
 * The point of resolving BEFORE inserting: "060-" should offer every number
 * that starts that way, and "uv bulb" should offer the bulb - which means one
 * field answers both "I have the box in my hand" and "I know what it is called
 * but not its number". Both end in the same place, an insert of the catalog's
 * own number rather than a fresh spelling of it.
 */
export function suggestParts<T extends CatalogEntry>(
  catalog: T[], query: string, limit = 8, kinds?: readonly string[],
): PartSuggestion<T>[] {
  const q = query.trim();
  if (!q) return [];
  const pn = normalizePn(q);
  return searchCatalog(catalog, q, limit, kinds).map((entry) => {
    const hitAlias = pn.length > 0
      ? (entry.aliases ?? []).find((a) => normalizePn(a.partNumber).includes(pn))
      : undefined;
    return {
      entry,
      // Always the entry's own number, never the one that was typed: inserting
      // a superseded number is the thing this whole path exists to stop.
      partNumber: entry.partNumber,
      name: entry.name,
      wasQuoted: hitAlias && isSuperseded(hitAlias) ? hitAlias.partNumber : "",
      alsoKnownAs: hitAlias && !isSuperseded(hitAlias) ? hitAlias.partNumber : "",
    };
  });
}
