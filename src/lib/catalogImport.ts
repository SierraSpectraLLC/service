// The equipment catalog as one sheet: modules and the OEMs that make them.
//
// Two thousand models arrive as a spreadsheet, not as two thousand trips
// through the New model dialog. What makes that safe is not the parser - it is
// the RAILING below, which decides for every line whether it is new, whether it
// is something already on file, or whether it is a second spelling of something
// already on file. The catalog is what every picker in the app reads from; a
// duplicate here is a model that exists twice and matches half the fleet each.
//
// THE COLUMN LIST IS THE ONLY COPY. Template, parser and export all read
// COLUMNS, so a sheet exported from the catalog page edits and imports straight
// back, and a re-import of an untouched export changes nothing at all.
//
// Pure - no db, no tenancy. The writes live in actions.importCatalog, and this
// file is what its tests and the preview table both reason about.

import { cleanMakerName } from "@/lib/makers";

export type CatalogImportRow = {
  moduleType: string;
  model: string;
  manufacturer: string;
  systemTypes: string;
};

export type CatalogImportColumn = {
  key: keyof CatalogImportRow;
  header: string;
  /** The template's example line, under the headers. */
  example: string;
};

/**
 * Left to right in the order somebody reads a model off a quote: what kind of
 * module it is, what it is called, who makes it, what it goes in.
 *
 * System types are semicolon-separated for the reason every multi-value cell in
 * this codebase is: a comma inside a cell survives only while the cell stays
 * quoted, and hand-editing an export in Excel is exactly where that breaks.
 */
export const COLUMNS: CatalogImportColumn[] = [
  { key: "moduleType", header: "Module type", example: "Pump" },
  { key: "model", header: "Model", example: "LC-20AD" },
  { key: "manufacturer", header: "Manufacturer (OEM)", example: "Shimadzu" },
  { key: "systemTypes", header: "System types (; separated)", example: "LC-MS; HPLC" },
];

export const blankRow = (): CatalogImportRow =>
  Object.fromEntries(COLUMNS.map((c) => [c.key, ""])) as CatalogImportRow;

/** Header noise a spreadsheet round trip adds: case, spaces, punctuation. */
const headerKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Generous on the header spelling, strict on the data. Somebody will send back
 * a sheet whose first column says "Type" or "Category" - refusing the file over
 * that is how an import feature goes unused. An UNRECOGNISED column is dropped
 * rather than assigned to whatever came next, because a mis-mapped column is
 * invisible in a CSV and writes nonsense into the book every picker reads.
 */
const ALIASES: Record<string, keyof CatalogImportRow> = {
  type: "moduleType", assettype: "moduleType", kind: "moduleType",
  module: "moduleType", moduletype: "moduleType", modulekind: "moduleType",
  name: "model", modelname: "model", modelno: "model", modelnumber: "model",
  maker: "manufacturer", mfr: "manufacturer", brand: "manufacturer",
  oem: "manufacturer", vendor: "manufacturer", manufacturer: "manufacturer",
  category: "systemTypes", categories: "systemTypes", systemtype: "systemTypes",
  systemtypes: "systemTypes", system: "systemTypes", systems: "systemTypes",
  platform: "systemTypes", platforms: "systemTypes",
};

export function matchHeader(cell: string): keyof CatalogImportRow | null {
  const k = headerKey(cell);
  if (!k) return null;
  const exact = COLUMNS.find((c) => headerKey(c.header) === k);
  if (exact) return exact.key;
  // The template's headers carry a parenthetical; try the part before it, so
  // "Manufacturer (OEM)" also matches a bare "Manufacturer".
  const head = COLUMNS.find((c) => headerKey(c.header.split("(")[0]) === k);
  if (head) return head.key;
  return ALIASES[k] ?? null;
}

/**
 * A pasted or uploaded grid, as rows this can act on.
 *
 * The first line counts as headers when it looks like headers - which an
 * exported sheet has and a hand-pasted block of data does not. Guessing wrong
 * toward "no headers" would silently eat somebody's first model; guessing wrong
 * the other way puts one junk line in a preview they are about to read anyway,
 * so the tie breaks toward keeping data.
 */
export function readGrid(grid: string[][]): CatalogImportRow[] {
  if (!grid.length) return [];
  const [first, ...rest] = grid;
  const matched = first.map(matchHeader);
  const looksLikeHeaders = matched.filter(Boolean).length >= 2;
  const order = looksLikeHeaders ? matched : COLUMNS.map((c) => c.key);
  const body = looksLikeHeaders ? rest : grid;

  return body.map((cells) => {
    const row = blankRow();
    order.forEach((k, i) => {
      if (!k) return;
      const v = (cells[i] ?? "").trim();
      if (v) row[k] = v;
    });
    return row;
  }).filter((r) => Object.values(r).some((v) => v !== ""));
}

/** The template: headers, then one filled-in line to copy. */
export const templateGrid = (): string[][] => [
  COLUMNS.map((c) => c.header),
  COLUMNS.map((c) => c.example),
];

/** "LC-MS; HPLC" -> ["LC-MS", "HPLC"]. Semicolons, in a CSV. */
export const splitCell = (s: string): string[] =>
  [...new Set(s.split(";").map((x) => x.trim()).filter(Boolean))];

/* ── The railing ─────────────────────────────────────────────────────────── */

/** vocab_terms' own rule, so a sheet cannot file a name the dialog refuses. */
export const NAME_MAX = 60;

/**
 * The IDENTITY key - what makes two lines the same module.
 *
 * Case and surrounding space are noise, so this folds them; nothing else is
 * touched. It is deliberately the same comparison addVocabTerm makes when
 * somebody types a model in by hand, because a sheet and the dialog disagreeing
 * about what "already defined" means is how the duplicate gets in.
 */
export const modelKey = (moduleType: string, model: string) =>
  `${moduleType.trim().toLowerCase()}|${model.trim().toLowerCase()}`;

/**
 * The SPELLING key - what makes two names probably the same thing said twice.
 *
 * Everything that is not a letter or a digit comes out, so "LC-20AD", "LC 20AD"
 * and "lc20ad" collapse together, as do "Agilent Technologies, Inc." and
 * "Agilent Technologies Inc". That is the whole class it catches: punctuation,
 * spacing and case. It does NOT reach "Agilent" vs "Agilent Technologies" -
 * those stay two names, because deciding they are one is a judgement about the
 * shop's vocabulary and not something an importer should make on its own.
 */
export const looseKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * What one line turns out to be.
 *
 *   new      nothing like it on file - insert it
 *   same     already on file and the sheet adds nothing - the no-op that makes
 *            re-importing an untouched export change nothing
 *   merge    already on file, and the sheet widens it: system types it did not
 *            carry, or a maker where it had none
 *   conflict already on file with a DIFFERENT maker - skipped. What is on file
 *            was put there by somebody; a spreadsheet does not get to overwrite
 *            it silently, which is the whole point of the railing
 *   repeat   the same module appeared earlier in this same file
 *   nearby   a second spelling of something on file (or of an earlier line) -
 *            skipped, and the existing spelling is named so the fix is obvious
 *   oem      a maker with no model: a line for the manufacturer book alone
 *   problem  unusable - no name, no module type, too long
 */
export type Verdict = "new" | "same" | "merge" | "conflict" | "repeat" | "nearby" | "oem" | "problem";

export type PlannedRow = {
  line: number;
  row: CatalogImportRow;
  verdict: Verdict;
  /** Set for every verdict a person needs to read: why, in their words. */
  note?: string;
  /** new/merge only: what to write. Absent means the line writes nothing. */
  write?: {
    /** Present for a model line; absent on an OEM-book line. */
    model?: { id: number | null; moduleType: string; name: string; manufacturer: string; categories: string[] };
    /** The maker to make sure the book carries, if any. */
    maker?: string;
  };
};

export type ExistingModel = {
  id: number;
  moduleType: string;
  name: string;
  manufacturer: string;
  categories: string[];
};

export type CatalogPlan = {
  rows: PlannedRow[];
  /** Verdict tallies, for the line the preview leads with. */
  counts: Record<Verdict, number>;
  /** Module types and system types the sheet names that do not exist yet. */
  newModuleTypes: string[];
  newSystemTypes: string[];
  newMakers: string[];
};

/**
 * Decide every line against what is on file AND against the lines before it.
 *
 * Stateful on purpose: a model created by line 12 has to be on file as far as
 * line 1500 is concerned, or a sheet that lists the same pump twice files it
 * twice - the duplicate this exists to prevent, arriving from inside the very
 * file that was supposed to be checked.
 */
export function planCatalogImport(
  rows: CatalogImportRow[],
  existing: {
    models: ExistingModel[];
    /** Every module type the catalog defines, however spelled. */
    moduleTypes: string[];
    systemTypes: string[];
    /** The manufacturer book: defined names and names already in use. */
    makers: string[];
  },
): CatalogPlan {
  /* What is on file, plus what this sheet has decided to add so far. An entry
     carrying `plannedAt` was created by a line of THIS sheet - which is how a
     second mention of the same module knows to fold into the first line's write
     instead of filing a second row beside it. */
  type Entry = ExistingModel & { plannedAt?: number };
  const byId = new Map<string, Entry>();
  const bySpelling = new Map<string, Entry>();
  const index = (e: Entry) => {
    byId.set(modelKey(e.moduleType, e.name), e);
    const sp = `${looseKey(e.moduleType)}|${looseKey(e.name)}`;
    if (!bySpelling.has(sp) || bySpelling.get(sp)?.name === e.name) bySpelling.set(sp, e);
  };
  for (const m of existing.models) index({ ...m });

  const makerBySpelling = new Map<string, string>();
  for (const raw of existing.makers) {
    const name = cleanMakerName(raw);
    const k = looseKey(name);
    if (k && !makerBySpelling.has(k)) makerBySpelling.set(k, name);
  }
  const knownType = new Map<string, string>();
  for (const t of existing.moduleTypes) if (t.trim()) knownType.set(looseKey(t), t.trim());
  const knownSystem = new Map<string, string>();
  for (const t of existing.systemTypes) if (t.trim()) knownSystem.set(looseKey(t), t.trim());

  const out: PlannedRow[] = [];
  const newModuleTypes: string[] = [];
  const newSystemTypes: string[] = [];
  const newMakers: string[] = [];

  /* A name the catalog already knows, however this sheet spelled it. Keeping
     the book's spelling is not a rewrite of what the sheet said - it is the
     same name, and the book exists so there is one of it. The class this
     catches is punctuation and spacing only; "Agilent" and "Agilent
     Technologies" stay two names, because deciding they are one is a judgement
     about the shop's vocabulary that an importer does not get to make. */
  const settleMaker = (raw: string): { name: string; renamedFrom?: string } => {
    const clean = cleanMakerName(raw);
    if (!clean) return { name: "" };
    const known = makerBySpelling.get(looseKey(clean));
    return known && known !== clean ? { name: known, renamedFrom: clean } : { name: known ?? clean };
  };
  const learnMaker = (name: string) => {
    if (!name || makerBySpelling.has(looseKey(name))) return;
    makerBySpelling.set(looseKey(name), name);
    newMakers.push(name);
  };
  const learnSystem = (c: string) => {
    if (knownSystem.has(looseKey(c))) return;
    knownSystem.set(looseKey(c), c);
    newSystemTypes.push(c);
  };

  rows.forEach((row, i) => {
    const line = i + 1;
    const push = (verdict: Verdict, note?: string, write?: PlannedRow["write"]) => {
      out.push({ line, row, verdict, note, write });
      return out[out.length - 1];
    };

    const model = row.model.trim();
    const rawType = row.moduleType.trim();
    const maker = settleMaker(row.manufacturer);

    // ── A maker and nothing else: a line for the OEM book alone.
    if (!model) {
      if (!maker.name) { push("problem", "Nothing on this line"); return; }
      /* Nothing to do either way - the book has this maker. Not a line anybody
         needs to act on, so it is "same" rather than a flag; the note still
         carries the sheet's own spelling, because "we write it the other way"
         is worth knowing when two thousand rows use the other way. */
      if (makerBySpelling.has(looseKey(maker.name))) {
        push("same", maker.renamedFrom
          ? `Already in the manufacturer book as "${maker.name}" (the sheet said "${maker.renamedFrom}")`
          : `${maker.name} is already in the manufacturer book`);
        return;
      }
      learnMaker(maker.name);
      push("oem", `New manufacturer: ${maker.name}`, { maker: maker.name });
      return;
    }

    // ── A model line.
    if (!rawType) { push("problem", `"${model}" does not say what kind of module it is`); return; }
    if (model.length > NAME_MAX) { push("problem", `Model name is over ${NAME_MAX} characters`); return; }
    if (rawType.length > NAME_MAX) { push("problem", `Module type is over ${NAME_MAX} characters`); return; }

    const moduleType = knownType.get(looseKey(rawType)) ?? rawType;
    const categories = splitCell(row.systemTypes)
      .map((c) => knownSystem.get(looseKey(c)) ?? c)
      .filter(Boolean);

    const idKey = modelKey(moduleType, model);
    const spellKey = `${looseKey(moduleType)}|${looseKey(model)}`;
    const hit = byId.get(idKey);
    const near = hit ? undefined : bySpelling.get(spellKey);

    /* The rail that earns its keep on a two thousand line sheet: the same pump
       written "LC-20AD" here and "LC20AD" there. Folding them together would be
       a guess about the shop's vocabulary, so this stops and names the row that
       already exists - the fix is one find-and-replace in their spreadsheet,
       and a re-import then reads as unchanged. */
    if (near) {
      push("nearby", near.plannedAt
        ? `Line ${near.plannedAt} of this sheet spells it "${near.name}"`
        : `Looks like "${near.name}" (${near.moduleType}), already on file`);
      return;
    }

    if (hit) {
      const addCats = categories.filter(
        (c) => !hit.categories.some((h) => h.toLowerCase() === c.toLowerCase()));
      const clashesMaker = !!maker.name && !!hit.manufacturer
        && looseKey(hit.manufacturer) !== looseKey(maker.name);
      const fillsMaker = !!maker.name && !hit.manufacturer;

      if (clashesMaker) {
        // What is on file was put there by somebody. A spreadsheet does not get
        // to overwrite it silently - that IS the railing.
        push("conflict", hit.plannedAt
          ? `Line ${hit.plannedAt} of this sheet says ${hit.manufacturer}; this one says ${maker.name}`
          : `On file as made by ${hit.manufacturer}; the sheet says ${maker.name}. Left alone.`);
        return;
      }

      // A module this sheet already spoke for: fold the extra into that line's
      // write, so one module is one write however many lines mention it.
      if (hit.plannedAt) {
        if (addCats.length || fillsMaker) {
          const earlier = out.find((p) => p.line === hit.plannedAt);
          if (earlier?.write?.model) {
            earlier.write.model.categories = [...earlier.write.model.categories, ...addCats];
            if (fillsMaker) earlier.write.model.manufacturer = maker.name;
          }
          hit.categories = [...hit.categories, ...addCats];
          if (fillsMaker) hit.manufacturer = maker.name;
          addCats.forEach(learnSystem);
          if (fillsMaker) learnMaker(maker.name);
        }
        push("repeat", `Line ${hit.plannedAt} of this sheet already has it`);
        return;
      }

      if (!addCats.length && !fillsMaker) { push("same", "Already on file, unchanged"); return; }
      hit.categories = [...hit.categories, ...addCats];
      if (fillsMaker) hit.manufacturer = maker.name;
      addCats.forEach(learnSystem);
      if (fillsMaker) learnMaker(maker.name);
      push("merge", [
        addCats.length ? `adds ${addCats.join(", ")}` : "",
        fillsMaker ? `sets the maker to ${maker.name}` : "",
      ].filter(Boolean).join("; "), {
        model: {
          id: hit.id, moduleType, name: hit.name,
          manufacturer: hit.manufacturer, categories: hit.categories,
        },
      });
      return;
    }

    // ── Genuinely new.
    if (!knownType.has(looseKey(moduleType))) {
      knownType.set(looseKey(moduleType), moduleType);
      newModuleTypes.push(moduleType);
    }
    categories.forEach(learnSystem);
    learnMaker(maker.name);
    const fresh: Entry = {
      id: 0, plannedAt: line, moduleType, name: model,
      manufacturer: maker.name, categories,
    };
    index(fresh);
    push("new", maker.renamedFrom
      ? `Filed under the book's spelling "${maker.name}" (the sheet said "${maker.renamedFrom}")`
      : undefined,
    { model: { id: null, moduleType, name: model, manufacturer: maker.name, categories: fresh.categories }, maker: maker.name || undefined });
  });

  const counts = out.reduce((acc, p) => { acc[p.verdict]++; return acc; }, {
    new: 0, same: 0, merge: 0, conflict: 0, repeat: 0, nearby: 0, oem: 0, problem: 0,
  } as Record<Verdict, number>);

  return { rows: out, counts, newModuleTypes, newSystemTypes, newMakers };
}

/** The verdicts that put something in the catalog. */
export const writesSomething = (v: Verdict) => v === "new" || v === "merge" || v === "oem";

/** The verdicts a person has to read before they commit. */
export const needsReading = (v: Verdict) =>
  v === "conflict" || v === "nearby" || v === "problem";

/**
 * What is already on file, in the template's own columns.
 *
 * The round trip is the point, and it is what the shop asked for first: export
 * this to see the shape, put the two thousand new ones under it, send it back.
 * A model with three system types is ONE line with a semicolon list, not three
 * lines - because that is the shape planCatalogImport reads back as one model.
 *
 * Makers that own no model come last, on lines with a maker and nothing else,
 * so the manufacturer book survives the round trip too instead of quietly
 * shrinking to whoever happens to make something.
 */
export function exportGrid(
  models: { moduleType: string; name: string; manufacturer: string; categories: string[] }[],
  makers: string[] = [],
): string[][] {
  const out: string[][] = [COLUMNS.map((c) => c.header)];
  const sorted = [...models].sort((a, b) =>
    a.moduleType.localeCompare(b.moduleType)
    || (a.manufacturer || "~").localeCompare(b.manufacturer || "~")
    || a.name.localeCompare(b.name));
  for (const m of sorted) {
    const row: CatalogImportRow = {
      moduleType: m.moduleType, model: m.name,
      manufacturer: m.manufacturer, systemTypes: m.categories.join("; "),
    };
    out.push(COLUMNS.map((c) => row[c.key]));
  }
  const spoken = new Set(sorted.map((m) => looseKey(m.manufacturer)).filter(Boolean));
  for (const name of [...makers].sort((a, b) => a.localeCompare(b))) {
    if (!name.trim() || spoken.has(looseKey(name))) continue;
    const row: CatalogImportRow = { ...blankRow(), manufacturer: name };
    out.push(COLUMNS.map((c) => row[c.key]));
  }
  return out;
}
