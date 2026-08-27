// The write-path twin of tests/tenantReadScoping.
//
// That test catches a read of a tenant-stamped table with no WHERE at all.
// This one catches the shape that produced almost every write-side hole found
// in this codebase: fetch a row by an id the CALLER supplied, check a ROLE,
// mutate. requireStaff, requireEditor, requireOwner and isHouse are all true
// for every operator's people, so where one of them is the only gate, the id
// in the request is the entire authorization.
//
// That shape produced, among others: house-member writes that minted a
// temporary password for another workspace's owner; removeAssets deleting two
// hundred rows an id at a time; handOffSystem moving a system and deleting its
// real owner's share; setRemoteConsent turning off the prompt on somebody
// else's instrument PC; and payExpenseReport marking another company's
// reimbursement paid.
//
// THIS IS A RATCHET, NOT A CLEAN BILL. The list below is sites nobody has
// reviewed yet, not sites known to be safe. Its only guarantee is that the
// number does not grow: a new write on a stamped table either shows it has
// thought about whose row it is, or it lands here and somebody has to say why.
// Entries come OFF the list as they are reviewed - by adding a real guard, or
// by adding the helper that already guards them to GUARD_VOCABULARY below.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

/**
 * Anything that means "somebody worked out whose row this is".
 *
 * Includes the guard HELPERS, not just the primitives: validationDocAccess
 * reaches assertSystemVisible, mayEditPayroll reaches maySeePayroll, and a
 * function calling either has done the work even though the words readTenant
 * and forTenant appear nowhere in it.
 */
const GUARD_VOCABULARY = new RegExp([
  // primitives
  "houseOf\\(", "forTenant\\(", "readTenant\\(", "myTenantOrgId\\(", "tenantOrgId",
  "isPlatformStaff\\(", "tenantOfOrg\\(", "storeTenantFor\\(",
  // assertions
  "assertSystem", "assertWork", "assetAccess\\(", "canEditSystem\\(", "scopeFor\\(",
  // named gates that resolve a record's workspace before they let anything through
  "adminOrgGate\\(", "mayAdminOrg\\(", "maySeeBooks\\(", "mayEditPayroll\\(",
  "validationDocAccess\\(", "assertRequestDecider\\(", "guardFor\\(", "ownStage\\(",
  "folderById\\(", "roomAccess\\(", "deviceWithOrg\\(", "stockAccess\\(",
].join("|"));

/** Table constants declared with tenantStamp(). */
function stampedTables(): string[] {
  const sch = readFileSync("src/db/schema.ts", "utf8");
  const starts = [...sch.matchAll(/export const (\w+) = pgTable\(/g)].map((m) => [m.index!, m[1]] as const);
  return starts
    .filter(([pos], i) => sch.slice(pos, i + 1 < starts.length ? starts[i + 1][0] : sch.length).includes("tenantStamp()"))
    .map(([, name]) => name);
}

type Site = { file: string; line: number; table: string; fn: string };

/** Writes to a stamped table inside a function with no tenant vocabulary. */
function unguardedWrites(tables: string[]): Site[] {
  let out: string;
  try {
    out = execFileSync("grep", ["-rn", "--include=*.ts", "--include=*.tsx",
      "-E", String.raw`db\.(update|delete)\((${tables.join("|")})\)`, "src/"], { encoding: "utf8" });
  } catch { return []; }
  const cache = new Map<string, string[]>();
  const sites: Site[] = [];
  for (const row of out.split("\n").filter(Boolean)) {
    const [file, lineNo] = row.split(":", 2);
    const n = parseInt(lineNo);
    if (!cache.has(file)) cache.set(file, readFileSync(file, "utf8").split("\n"));
    const src = cache.get(file)!;
    // Back to the enclosing function declaration.
    let start = 0;
    for (let i = n - 1; i >= 0; i--) {
      if (/^(export )?(async )?function |^(export )?const \w+ = (async )?\(/.test(src[i])) { start = i; break; }
    }
    const body = src.slice(start, n + 3).join("\n")
      // Comments stripped: a function explaining WHY it needs no tenant test
      // must not pass by naming one. Learned three times over.
      .replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
    if (GUARD_VOCABULARY.test(body)) continue;
    const fnLine = src[start].trim();
    const name = /(?:function|const)\s+(\w+)/.exec(fnLine)?.[1] ?? `line${start + 1}`;
    sites.push({ file, line: n, table: /db\.(?:update|delete)\((\w+)\)/.exec(src[n - 1])![1], fn: name });
  }
  return sites;
}

/*
 * Reviewed and left alone, with the reason. Everything NOT here is unreviewed
 * and counted by the ratchet below.
 */
const REVIEWED: Record<string, string> = {
  "payExpenseReport": "Guarded as of this commit - houseOf(u, report.tenantOrgId).",
};

describe("writes to a tenant-stamped table", () => {
  const tables = stampedTables();

  it("the schema still stamps the tables this test is about", () => {
    expect(tables.length).toBeGreaterThan(30);
    for (const t of ["workOrders", "instruments", "expenseReports", "purchaseOrders"]) {
      expect(tables).toContain(t);
    }
  });

  /*
   * The ratchet. This number is a debt, not a target: it counts writes nobody
   * has yet confirmed can only touch their own workspace's rows. It may fall
   * freely. It may not rise - a new one means a new function taking an id off
   * the wire and mutating a stamped row without establishing whose it is,
   * which is exactly how every hole in this area got here.
   *
   * Lower it when you review some. Do not raise it.
   *
   * Set from what THIS scan counts, not from an earlier one-off script. The
   * first version of this number came from a sizing pass with a shorter guard
   * list and no comment stripping; it read 48, the real scan reads 43, and the
   * four slots of slack let a deliberately unguarded test write slip under the
   * bar. A ceiling measured by anything other than the check it governs is not
   * a ceiling.
   */
  const CEILING = 43;

  it(`no more than ${CEILING} unreviewed write sites`, () => {
    const sites = unguardedWrites(tables).filter((s) => !(s.fn in REVIEWED));
    const named = sites.map((s) => `${s.file}:${s.line} ${s.fn}(${s.table})`);
    // Printed on failure so a new one is identified rather than merely counted.
    expect(named.length, `unreviewed write sites:\n  ${named.join("\n  ")}`)
      .toBeLessThanOrEqual(CEILING);
  });

  it("the reviewed list has no stale entries", () => {
    // A function that has since gained a guard drops out of the scan entirely,
    // and its note here would then be describing nothing.
    const flagged = new Set(unguardedWrites(tables).map((s) => s.fn));
    const stale = Object.keys(REVIEWED).filter((fn) => !flagged.has(fn));
    // payExpenseReport is expected to be stale the moment its guard lands -
    // that is the entry doing its job, and it stays as the worked example of
    // what a review looks like.
    expect(stale).toEqual(["payExpenseReport"]);
  });
});
