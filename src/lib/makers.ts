// The manufacturer & vendor book. "Shimadzu" is typed in eight different
// columns - model catalog, systems, units, part book, part aliases, part rows,
// price book, purchase orders - and until now each spelling lived on its own
// row with its own tiny "rename maker" link. This is the one list they all
// reference: defined names first-class, in-use names surfaced so nothing the
// shop has typed can hide, and a rename is one operation that reaches every
// column (actions.renameMaker).
//
// Pure: the settings page brings the rows, this decides what the list looks
// like. Same philosophy as parts - defining a maker is never REQUIRED to use
// one; the book describes, it doesn't gatekeep.

/** Where a name was seen. The labels double as the card's usage line. */
export const MAKER_SOURCES = ["models", "systems", "units", "parts", "buying"] as const;
export type MakerSource = (typeof MAKER_SOURCES)[number];

export type MakerRow = {
  /** vocab_terms id when defined; null for a spelling only seen in use. */
  id: number | null;
  name: string;
  usage: Record<MakerSource, number>;
  total: number;
};

/**
 * One spelling, cleaned: trimmed, inner whitespace collapsed, capped. The cap
 * matches vocab_terms' 60-char name rule so a defined maker and a used one
 * can't disagree about legality.
 */
export function cleanMakerName(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, 60);
}

/**
 * Merge the defined list with everything in use, case-insensitively.
 *
 * The defined spelling wins the display - that is what defining is FOR. An
 * undefined name shows the spelling most seen in the wild (ties: first wins in
 * source order), with id null so the card can offer "define" rather than
 * rename-only. Sorted by name; empty names never make the list.
 */
export function mergeMakers(
  defined: { id: number; name: string }[],
  used: { name: string; source: MakerSource }[],
): MakerRow[] {
  const zero = (): Record<MakerSource, number> =>
    Object.fromEntries(MAKER_SOURCES.map((s) => [s, 0])) as Record<MakerSource, number>;
  const rows = new Map<string, MakerRow & { spellings: Map<string, number> }>();
  const at = (name: string) => {
    const key = name.toLowerCase();
    let r = rows.get(key);
    if (!r) {
      r = { id: null, name, usage: zero(), total: 0, spellings: new Map() };
      rows.set(key, r);
    }
    return r;
  };
  for (const d of defined) {
    const name = cleanMakerName(d.name);
    if (!name) continue;
    const r = at(name);
    r.id = d.id;
    r.name = name; // the defined spelling is the display spelling
  }
  for (const u of used) {
    const name = cleanMakerName(u.name);
    if (!name) continue;
    const r = at(name);
    r.usage[u.source]++;
    r.total++;
    r.spellings.set(name, (r.spellings.get(name) ?? 0) + 1);
  }
  for (const r of rows.values()) {
    if (r.id !== null) continue;
    let best = r.name, n = 0;
    for (const [s, count] of r.spellings) if (count > n) { best = s; n = count; }
    r.name = best;
  }
  return [...rows.values()]
    .map(({ spellings: _drop, ...r }) => r)
    .sort((a, b) => a.name.localeCompare(b.name));
}

const SOURCE_LABEL: Record<MakerSource, string> = {
  models: "model",
  systems: "system",
  units: "unit",
  parts: "part",
  buying: "price/PO line",
};

/** "4 models · 2 units" - the card's usage line. Empty when unused. */
export function makerUsageLine(r: MakerRow): string {
  return MAKER_SOURCES
    .filter((s) => r.usage[s] > 0)
    .map((s) => `${r.usage[s]} ${SOURCE_LABEL[s]}${r.usage[s] === 1 ? "" : "s"}`)
    .join(" · ");
}
