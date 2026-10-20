// A test whose result is a TABLE: a row per point checked, what each read,
// and whether each one passed.
//
// A tune check on a mass spec is not one number. "Positive Scan Mode - MS1"
// is four masses, an intensity read at each and a verdict on each, and the
// service report prints it as exactly that grid. Recording it as four tests
// would put four separate tasks where the engineer thinks of one; recording
// it as a note would lose the verdicts. So the value is the grid itself,
// stored as JSON in task_results.value like every other result is stored as
// what was read.
//
// Pure, for the same reason lib/testResult is: the browser shows the verdict
// before it is recorded and the server must reach the same one.

export type ResultTable = {
  /** The headings of the first two columns. The third is always Pass/Fail. */
  cols: [string, string];
  /** [point, measured, "Pass" | "Fail" | ""] */
  rows: [string, string, string][];
};

/** What a hand-made table starts as - the mass spec tune check it was built for. */
export const DEFAULT_COLS: [string, string] = ["Mass (Da)", "m/z Intensity Measured"];

const s = (v: unknown, max = 60) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const verdictOf = (v: unknown) => (/^pass$/i.test(s(v)) ? "Pass" : /^fail$/i.test(s(v)) ? "Fail" : "");

/** Read a stored table back. Anything that is not one reads as null, never a crash. */
export function parseTable(value: string | null | undefined): ResultTable | null {
  const raw = (value ?? "").trim();
  if (!raw.startsWith("{")) return null;
  try {
    const j = JSON.parse(raw) as { cols?: unknown; rows?: unknown };
    const cols = Array.isArray(j.cols) ? j.cols : [];
    const rows = Array.isArray(j.rows) ? j.rows : [];
    return {
      cols: [s(cols[0]) || DEFAULT_COLS[0], s(cols[1]) || DEFAULT_COLS[1]],
      rows: rows.slice(0, 40).map((r) => {
        const a = Array.isArray(r) ? r : [];
        return [s(a[0]), s(a[1]), verdictOf(a[2])] as [string, string, string];
      }),
    };
  } catch {
    return null;
  }
}

/** The rows anybody filled in, as stored. Empty rows are dropped. */
export function serializeTable(t: ResultTable): string {
  const rows = t.rows
    .map((r) => [r[0].trim(), r[1].trim(), verdictOf(r[2])] as [string, string, string])
    .filter((r) => r[0] || r[1]);
  return JSON.stringify({ cols: [t.cols[0].trim() || DEFAULT_COLS[0], t.cols[1].trim() || DEFAULT_COLS[1]], rows });
}

/**
 * The table a test starts from: the procedure's own points when it names them
 * (acceptance.columns / acceptance.rows), else four blank rows.
 */
export function blankTable(acc: { columns?: string[]; rows?: string[] }): ResultTable {
  const points = acc.rows?.filter((r) => r.trim()) ?? [];
  return {
    cols: [acc.columns?.[0]?.trim() || DEFAULT_COLS[0], acc.columns?.[1]?.trim() || DEFAULT_COLS[1]],
    rows: (points.length ? points : ["", "", "", ""]).map((p) => [p.trim(), "", ""]),
  };
}

/** Recorded = at least one row read, and every row that was read has a verdict. */
export function tableIsRecorded(value: string): boolean {
  const t = parseTable(value);
  if (!t) return false;
  const read = t.rows.filter((r) => r[0] || r[1]);
  return read.length > 0 && read.every((r) => r[1] && r[2]);
}

/** Passed when every row passed; failed when any did. */
export function tableVerdict(value: string): { passed: boolean | null; why: string } {
  const t = parseTable(value);
  if (!t || !t.rows.length) return { passed: null, why: "" };
  const fails = t.rows.filter((r) => r[2] === "Fail");
  const passes = t.rows.filter((r) => r[2] === "Pass");
  if (fails.length) {
    return { passed: false, why: `${fails.length} of ${t.rows.length} failed (${fails.map((r) => r[0]).filter(Boolean).join(", ")})` };
  }
  if (passes.length === t.rows.length) return { passed: true, why: `all ${t.rows.length} passed` };
  return { passed: null, why: `${passes.length} of ${t.rows.length} judged` };
}
