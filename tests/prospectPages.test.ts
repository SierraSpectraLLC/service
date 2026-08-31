// Every room that draws the working fleet asks who is a prospect.
//
// The rule lives in lib/prospects, but a rule in a library is not a rule until
// the call sites use it - and the failure mode is silent and slow: somebody
// adds a fleet page next year, writes the archived/tenant filters everybody
// writes, and a stranger's machines are back on the board with nothing
// throwing. Nobody notices until a shop asks why it is being nagged to PM a
// company that never signed.
//
// So this is a textual check over the pages that draw the fleet, the same
// posture tests/tenantStamp takes to the tenant column. Adding a room to the
// list is a deliberate act; forgetting the rule in one already on it is not.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The rooms whose lists ARE the shop's working fleet - what it is looking
 * after this week.
 *
 * Deliberately not every page that mentions a system. A client's own record,
 * the document picker and the agreement's coverage picker all name a
 * prospect's systems on purpose: the record is complete, and quoting them is
 * the whole reason the systems exist. What is held back is the fleet.
 */
const FLEET_ROOMS = [
  "src/app/(dashboard)/page.tsx",
  "src/app/units/page.tsx",
  "src/app/metrics/page.tsx",
  "src/app/maintenance/page.tsx",
];

const strip = (file: string) =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

describe("the fleet rooms hold a prospect's systems back", () => {
  for (const file of FLEET_ROOMS) {
    it(`${file} asks lib/prospects`, () => {
      const src = strip(file);
      // Comments stripped first: each of these files EXPLAINS the rule in
      // prose, and a check over raw text would pass on the explanation while
      // the query underneath had lost it.
      const asks = /prospectHold\s*\(/.test(src) && /notProspect\s*\(/.test(src);
      expect(`${file}: ${asks ? "asks" : "MISSING the prospect rule"}`).toBe(`${file}: asks`);
    });
  }

  it("keeps the rule in one place rather than open-coding the column", () => {
    /*
     * The other way this decays: a page reads orgs.prospect itself and builds
     * its own condition, which is how the NULL-instrument bug gets reinvented
     * one page at a time. The flag is lib/prospects' to read.
     */
    for (const file of FLEET_ROOMS) {
      const src = strip(file);
      expect(`${file}: ${/orgs\.prospect/.test(src) ? "open-coded" : "clean"}`).toBe(`${file}: clean`);
    }
  });
});
