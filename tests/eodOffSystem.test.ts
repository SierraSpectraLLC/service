import { describe, expect, it } from "vitest";
import { isOffSystem } from "@/lib/eodEmail";

/**
 * The gap: every EOD line hung off a system or an asset, so work that touched
 * neither had nowhere to go. A client's engineer rings up, one of ours talks
 * them through it for half an hour, and the day's report says nothing happened
 * - because the report could only describe equipment.
 *
 * These rows carry no instrument and no asset. What marks one is the title:
 * without a record behind it, the title is the only thing that says what the
 * line IS. That makes the predicate load-bearing rather than cosmetic - it
 * decides which rows become report lines and which client's report they land
 * on, so a wrong answer either loses the work or shows it to the wrong people.
 */
const row = (over: Partial<Parameters<typeof isOffSystem>[0]> = {}) => ({
  instrumentId: null, assetId: null, title: "Phone support - tune report", ...over,
});

describe("what counts as work logged off the board", () => {
  it("no system, no unit, and a title saying what it was", () => {
    expect(isOffSystem(row())).toBe(true);
  });

  it("a line about a system is not one of these, title or no title", () => {
    expect(isOffSystem(row({ instrumentId: 7 }))).toBe(false);
    expect(isOffSystem(row({ assetId: 3 }))).toBe(false);
  });

  /**
   * The row that matters most here. saveEodUpdate can leave a row with nothing
   * on it - somebody opened a line and typed nothing - and such a row has no
   * instrument and no asset either. Treating it as off-system work would put a
   * blank heading on a client's email.
   */
  it("an empty row is debris, not a record", () => {
    expect(isOffSystem(row({ title: "" }))).toBe(false);
    expect(isOffSystem(row({ title: "   " }))).toBe(false);
  });
});
