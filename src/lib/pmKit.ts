// What one PM on one model actually takes: the parts, and the hours.
//
// The lookup behind the estimate builder. Type "API 5000" and the kit and the
// consumables should appear - the PM kit, two litres of pump oil - because
// somebody already wrote that down once in the procedure catalog and nobody
// should retype it into a bid at midnight three days before a deadline.
//
// Nothing here is new knowledge. It is four things the app already holds,
// joined for the first time:
//
//   procedures      the work, scoped to a model or a system category, with
//                   its parts list (name, number, qty) and now its minutes
//   part_catalog    what a number IS - and whether it is a KIT, meaning a bag
//                   of other numbers stocked and sold as one thing
//   part_kit_lines  what is in the bag, and how many of each
//   part_prices     what anybody charges for it, by vendor
//
// RECURRING WORK ONLY. A procedure with no interval is intake work - incoming
// inspection, the first leak check - and it happens once when a system arrives,
// not every year of a contract. Counting it made a bid's hours per visit half
// again too big and buried the real warnings under nine checkout tests nobody
// was pricing. A PM kit is what RECURS.
//
// And what recurs, recurs at its OWN rate. A quarterly source clean and an
// annual teardown are 4 + 1 events a year, so a year costs four cleans and one
// teardown - the arithmetic is annual first, and per-visit is that divided by
// the journeys. Getting this backwards (one of each, once) is a bid missing
// three source cleans, which is most of a day of labor and three capillaries.
//
// Two more rules carry the module and both are about honesty rather than
// arithmetic.
//
// A KIT COSTS WHAT THE KIT COSTS. If the bag has a price of its own that is
// the price - it is what the purchase order will say. Only when nobody has
// priced the bag do we fall back to summing its contents, and the line says so,
// because a summed bag and a quoted bag are different degrees of confidence and
// a bid built on the second should not look like the first.
//
// AN UNPRICED PART IS NOT A FREE PART. Anything the price book has never heard
// of comes back priced: false and named in `unpriced`, and the same for a
// procedure carrying no time estimate. Silently totalling either as zero is how
// a firm-fixed price goes out the door missing a $900 detector kit, and this
// whole feature exists to stop exactly that.
//
// Pure. Callers hand in the rows.

import { bestPrice, normalizePn, type PriceEntry } from "@/lib/priceBook";
import { partQty, partsForModel, parseProcParts, type ProcPart } from "@/lib/procedures";
import { scopeMatches } from "@/lib/checkout";

/** A part_catalog row, as much of it as this needs. */
export type CatalogEntry = {
  partNumber: string;
  name: string;
  /** part | consumable | kit */
  kind: string;
  /** part_kit_lines, when this is a kit. */
  lines?: { partNumber: string; name: string; qty: number }[];
};

/** A procedure, as much of it as this needs. */
export type KitProcedure = {
  id: number;
  name: string;
  assetType: string;
  /** JSON, the parts.specs convention - see lib/procedures. */
  parts: string;
  estMinutes: number;
  intervalDays: number | null;
  modelScope: string[];
  categoryScope: string[];
};

export type BomLine = {
  partNumber: string;
  name: string;
  qty: number;
  unitCents: number;
  totalCents: number;
  /** False when the price book has never heard of this number. */
  priced: boolean;
  /** True when a kit had no price of its own and this is its contents added up. */
  fromContents: boolean;
  /** Which procedures asked for it, for the "why is this here" question. */
  because: string[];
};

export type ModelKit = {
  model: string;
  /** A YEAR's bill of materials: each line's qty is what a year consumes. */
  lines: BomLine[];
  /** What a year of parts comes to. Unpriced lines contribute nothing - see `unpriced`. */
  partsCentsPerYear: number;
  /** What a year of this model's upkeep takes, across procedures that carry an estimate. */
  minutesPerYear: number;
  /**
   * Journeys the catalog implies: the rate of the MOST frequent recurring
   * procedure, because a quarterly job means being there quarterly however
   * rarely everything else falls due. Null = nothing recurring is written up.
   *
   * Only ever a SUGGESTION. What a contract promises is a negotiation - the
   * solicitation that prompted all this asks for two PM visits a year on
   * equipment whose catalog might say four - so the builder fills this in and
   * lets somebody change it.
   */
  visitsPerYear: number | null;
  /** The annual figures spread over those visits, so visits x per-visit = the year. */
  minutesPerVisit: number;
  partsCentsPerVisit: number;
  /** Procedures with no time on them. The hours figure is short by these. */
  untimed: string[];
  /** Part numbers nobody has priced. The parts figure is short by these. */
  unpriced: string[];
};

/**
 * The procedures that apply to one model of one system category.
 *
 * Both scopes are "empty means all", which is the convention the catalog
 * already uses everywhere: a procedure with no modelScope covers every model
 * of its asset type, and one with no categoryScope covers every category.
 */
export function proceduresForModel(
  all: KitProcedure[], model: string, category: string,
): KitProcedure[] {
  // scopeMatches is a plain membership test - the empty-means-all convention is
  // applied by its callers everywhere in the catalog (see checkout.matchItems
  // and procedures.partsForModel), and this is one more of them.
  const covers = (scope: string[], value: string) =>
    scope.length === 0 || scopeMatches(scope, value);
  return all.filter((p) => covers(p.modelScope, model) && covers(p.categoryScope, category));
}

/** Add one part row into the running bill, merging by part number. */
function add(
  into: Map<string, BomLine>,
  line: Omit<BomLine, "totalCents" | "because">,
  because: string,
): void {
  /*
   * Keyed on the normalised number, or on the NAME when a row has no number
   * at all. Two procedures both calling for "2 L pump oil" with no PN is one
   * consumable bought once, and treating them as two lines would double a bid
   * for no better reason than that nobody typed the number in.
   */
  const key = line.partNumber ? `#${normalizePn(line.partNumber)}` : `~${line.name.trim().toLowerCase()}`;
  const found = into.get(key);
  if (!found) {
    into.set(key, { ...line, totalCents: line.unitCents * line.qty, because: because ? [because] : [] });
    return;
  }
  found.qty += line.qty;
  found.totalCents = found.unitCents * found.qty;
  if (because && !found.because.includes(because)) found.because.push(because);
  // A row that arrived unpriced and later arrives priced takes the price: the
  // better-known fact wins, whichever order the procedures happened to be in.
  if (!found.priced && line.priced) {
    found.priced = true;
    found.unitCents = line.unitCents;
    found.fromContents = line.fromContents;
    found.totalCents = found.unitCents * found.qty;
  }
}

/**
 * What one part number costs, and how confidently.
 *
 * A kit's own listing beats its contents; contents beat nothing. Returns null
 * when neither is known, which the caller turns into an unpriced line rather
 * than a zero.
 */
export function priceOf(
  partNumber: string,
  catalog: CatalogEntry[],
  prices: PriceEntry[],
): { unitCents: number; fromContents: boolean } | null {
  const listed = bestPrice(prices, partNumber);
  if (listed) return { unitCents: listed.priceCents, fromContents: false };

  const key = normalizePn(partNumber);
  const entry = catalog.find((c) => normalizePn(c.partNumber) === key);
  if (!entry || entry.kind !== "kit" || !entry.lines?.length) return null;

  // The bag has no price of its own. Sum what is in it - but only if every
  // line is priced: a bag summed from three of its five contents is a number
  // that looks like a price and is not one.
  let sum = 0;
  for (const l of entry.lines) {
    const p = bestPrice(prices, l.partNumber);
    if (!p) return null;
    sum += p.priceCents * Math.max(1, l.qty);
  }
  return { unitCents: sum, fromContents: true };
}

/**
 * Everything one PM on one unit takes.
 *
 * `parts` on each procedure may name a kit, and a kit stays ONE LINE - it is
 * ordered, stocked and invoiced as one thing, and exploding it into its
 * contents would put five rows on a quote where the client will see one. The
 * contents are only consulted when nobody has priced the bag.
 */
export function kitForModel(input: {
  model: string;
  category: string;
  procedures: KitProcedure[];
  catalog: CatalogEntry[];
  prices: PriceEntry[];
}): ModelKit {
  const mine = proceduresForModel(input.procedures, input.model, input.category)
    // Recurring only. Intake work happens when a system arrives, not every year.
    .filter((p) => (p.intervalDays ?? 0) > 0);
  const lines = new Map<string, BomLine>();
  let minutesPerYear = 0;
  const untimed: string[] = [];
  let visitsPerYear: number | null = null;

  for (const p of mine) {
    // How many times a year THIS procedure happens. A 90-day job is four, an
    // annual one is one, and each contributes its own work at its own rate.
    const times = Math.max(1, Math.round(365 / (p.intervalDays as number)));
    visitsPerYear = Math.max(visitsPerYear ?? 0, times);

    const est = Math.max(0, Math.round(p.estMinutes));
    if (est > 0) minutesPerYear += est * times;
    else untimed.push(p.name);

    for (const raw of partsForModel(parseProcParts(p.parts), input.model)) {
      const priced = raw.number ? priceOf(raw.number, input.catalog, input.prices) : null;
      add(lines, {
        partNumber: raw.number,
        name: raw.name || nameFromCatalog(raw, input.catalog),
        qty: partQty(raw) * times,
        unitCents: priced?.unitCents ?? 0,
        priced: priced !== null,
        fromContents: priced?.fromContents ?? false,
      }, p.name);
    }
  }

  const out = fold([...lines.values()]).sort((a, b) =>
    b.totalCents - a.totalCents || a.name.localeCompare(b.name));
  const partsCentsPerYear = out.reduce((a, l) => a + l.totalCents, 0);
  const per = visitsPerYear ?? 0;
  return {
    model: input.model,
    lines: out,
    partsCentsPerYear,
    minutesPerYear,
    visitsPerYear,
    minutesPerVisit: per > 0 ? Math.round(minutesPerYear / per) : 0,
    partsCentsPerVisit: per > 0 ? Math.round(partsCentsPerYear / per) : 0,
    untimed,
    unpriced: out.filter((l) => !l.priced).map((l) => l.partNumber || l.name),
  };
}

/**
 * Fold a row that has a name but no part number into the row that has both.
 *
 * Real catalogs are half typed. One procedure says "Pump oil (AVF Gold)" with
 * the number on it and the next says just "Pump oil (AVF Gold)", and they are
 * one consumable bought once. Left alone they come out as two lines - one
 * priced, one a phantom - on every bid, which is noise the estimator has to
 * clear by hand each time.
 *
 * Only ever numberless INTO numbered, and only on an exact name match: two
 * rows carrying DIFFERENT numbers are two parts however alike their names,
 * which is the case this must never get wrong ("seal kit" is four things).
 */
function fold(lines: BomLine[]): BomLine[] {
  const numbered = lines.filter((l) => l.partNumber);
  return lines.filter((line) => {
    if (line.partNumber) return true;
    const key = line.name.trim().toLowerCase();
    if (!key) return true;
    const host = numbered.find((n) => n.name.trim().toLowerCase() === key);
    if (!host) return true;
    host.qty += line.qty;
    host.totalCents = host.unitCents * host.qty;
    for (const why of line.because) if (!host.because.includes(why)) host.because.push(why);
    return false;
  });
}

/** A part row with a number but no name reads better as the catalog's name for it. */
function nameFromCatalog(p: ProcPart, catalog: CatalogEntry[]): string {
  if (!p.number) return "";
  const key = normalizePn(p.number);
  return catalog.find((c) => normalizePn(c.partNumber) === key)?.name ?? "";
}

/** Has anybody written this model's upkeep down at all? */
export const kitIsEmpty = (kit: ModelKit): boolean =>
  kit.lines.length === 0 && kit.minutesPerYear === 0 && kit.visitsPerYear === null;
