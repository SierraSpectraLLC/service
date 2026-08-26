import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  COVERAGE, COVERAGE_STATES, advisoryByCoverage, coverageBadge, coverageLine, coverageOf,
  coverageSummary, type CoverageAgreement,
} from "@/lib/coverage";

/**
 * Who services a system, as executable checks.
 *
 * One rule carries the whole thing: visibility is not a relationship. The
 * landing counted the systems an organization could SEE and announced every
 * one of them as under service with the operator - a system touched once, a
 * system the manufacturer covers, and a system nobody has covered since 2025
 * all read identically, and all read as ours.
 *
 * The second rule is the split at the bottom of the state list. A lapse is
 * something we know; an absence of paperwork is something we do not.
 */

const TODAY = "2026-08-26";
const OPERATOR = "Sierra Spectra";

const agree = (over: Partial<CoverageAgreement> = {}): CoverageAgreement => ({
  id: 1, title: "Full service", number: "C-1", status: "active",
  startsOn: "2026-01-01", endsOn: "2027-03-01", renewNoticeDays: 60,
  instrumentIds: [], providerName: null, ...over,
});

describe("what covers a system", () => {
  it("says nothing at all when there is no paperwork", () => {
    // The reported case: QQQ-6, shared with us, worked on once, no contract
    // anywhere. It must not read as ours.
    const c = coverageOf(7, [], TODAY, OPERATOR);
    expect(c.state).toBe("unknown");
    expect(c.provider).toBe("");
    expect(coverageLine(c, TODAY)).toBe("No service contract on file");
    // Not "uncovered", "unprotected" or "no contract" - all three assert a
    // fact about the world rather than about our filing cabinet.
    expect(coverageLine(c, TODAY)).not.toMatch(/uncovered|unprotected|not covered/i);
  });

  it("reads ours from an agreement with no provider named", () => {
    // Null provider is what every agreement written before the column meant,
    // so this is also the no-backfill guarantee.
    const c = coverageOf(7, [agree()], TODAY, OPERATOR);
    expect(c.state).toBe("ours");
    expect(c.provider).toBe(OPERATOR);
    expect(coverageLine(c, TODAY)).toBe("Under service with Sierra Spectra until 2027-03-01");
  });

  it("reads somebody else's contract as theirs, by name", () => {
    const c = coverageOf(7, [agree({ providerName: "Agilent" })], TODAY, OPERATOR);
    expect(c.state).toBe("theirs");
    expect(coverageLine(c, TODAY)).toBe("Under service with Agilent until 2027-03-01");
    expect(coverageBadge(c)).toBe("Agilent");
  });

  it("reads a contract that ran out as lapsed, and says whose", () => {
    /* The difference that matters: this one we KNOW. "Agilent coverage ended
       2025-03-01" is a fact and a sales conversation; "no contract on file"
       is neither. */
    const c = coverageOf(7, [agree({ providerName: "Agilent", endsOn: "2025-03-01" })], TODAY, OPERATOR);
    expect(c.state).toBe("lapsed");
    expect(c.provider).toBe("Agilent");
    expect(coverageLine(c, TODAY)).toBe("Agilent coverage ended 2025-03-01");
  });

  it("treats a cancelled contract as lapsed and a draft as no contract", () => {
    // A draft never covered anything, so reporting "your contract ended"
    // about one would invent a relationship that never existed.
    expect(coverageOf(7, [agree({ status: "cancelled" })], TODAY, OPERATOR).state).toBe("lapsed");
    expect(coverageOf(7, [agree({ status: "draft" })], TODAY, OPERATOR).state).toBe("unknown");
  });

  it("honours the empty instrument list as the whole account", () => {
    // [] means every system - see agreements.instrumentIds. Reading it as
    // "no systems" would silently uncover every account-wide contract.
    expect(coverageOf(99, [agree({ instrumentIds: [] })], TODAY, OPERATOR).state).toBe("ours");
    expect(coverageOf(99, [agree({ instrumentIds: [1, 2] })], TODAY, OPERATOR).state).toBe("unknown");
    expect(coverageOf(2, [agree({ instrumentIds: [1, 2] })], TODAY, OPERATOR).state).toBe("ours");
  });

  it("lets live coverage beat lapsed coverage whoever holds it", () => {
    const c = coverageOf(7, [
      agree({ id: 1, providerName: "Agilent", endsOn: "2025-03-01" }),
      agree({ id: 2, providerName: "Thermo", endsOn: "2027-01-01" }),
    ], TODAY, OPERATOR);
    expect(c.state).toBe("theirs");
    expect(c.provider).toBe("Thermo");
  });

  it("puts ours first when both are live", () => {
    /* Not because ours matters more - because it is the one this instance can
       act on. A client reading "under contract with Agilent" on a system we
       also cover would reasonably stop calling us. */
    const c = coverageOf(7, [
      agree({ id: 1, providerName: "Agilent", endsOn: "2028-01-01" }),
      agree({ id: 2, providerName: null, endsOn: "2026-12-01" }),
    ], TODAY, OPERATOR);
    expect(c.state).toBe("ours");
  });

  it("prefers an open-ended contract over a dated one", () => {
    const c = coverageOf(7, [
      agree({ id: 1, providerName: "Agilent", endsOn: "2027-01-01" }),
      agree({ id: 2, providerName: "Agilent", endsOn: "" }),
    ], TODAY, OPERATOR);
    expect(c.agreementId).toBe(2);
    expect(coverageLine(c, TODAY)).toBe("Under service with Agilent · open-ended");
  });

  it("reports the most recently ended one when several have lapsed", () => {
    const c = coverageOf(7, [
      agree({ id: 1, providerName: "Agilent", endsOn: "2021-01-01" }),
      agree({ id: 2, providerName: "Thermo", endsOn: "2025-03-01" }),
    ], TODAY, OPERATOR);
    expect(c.provider).toBe("Thermo");
    expect(c.endsOn).toBe("2025-03-01");
  });

  it("still counts a contract inside its renewal window as live", () => {
    const c = coverageOf(7, [agree({ endsOn: "2026-09-15" })], TODAY, OPERATOR);
    expect(c.state).toBe("ours");
    expect(c.expiring).toBe(true);
  });

  it("gives every state a tone and an order, best first", () => {
    expect(COVERAGE_STATES).toEqual(["ours", "theirs", "lapsed", "unknown"]);
    const ranks = COVERAGE_STATES.map((s) => COVERAGE[s].rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    // Only a lapse is amber. Not knowing of a contract is not a warning about
    // the machine, it is a gap in our own records.
    expect(COVERAGE.lapsed.tone).toBe("warn");
    expect(COVERAGE.unknown.tone).toBe("neutral");
    expect(COVERAGE.ours.tone).toBe("good");
  });
});

describe("the line under Your lab", () => {
  it("names the operator only for the systems the operator covers", () => {
    expect(coverageSummary(["ours", "ours"], OPERATOR))
      .toBe("2 instruments under service with Sierra Spectra");
    expect(coverageSummary(["ours", "theirs", "unknown"], OPERATOR))
      .toBe("3 instruments · 1 under service with Sierra Spectra");
  });

  it("says the gap plainly when none of them are ours", () => {
    // The reported screenshot: one instrument, no contract, and a header that
    // announced it as under service with us.
    expect(coverageSummary(["unknown"], OPERATOR))
      .toBe("1 instrument · none under contract with Sierra Spectra");
    expect(coverageSummary(["lapsed", "theirs"], OPERATOR))
      .toBe("2 instruments · none under contract with Sierra Spectra");
  });

  it("says nothing about service for an empty account", () => {
    expect(coverageSummary([], OPERATOR)).toBe("No instruments on file yet");
  });
});

describe("what coverage changes elsewhere", () => {
  it("goes advisory only for a system somebody else maintains", () => {
    /* A machine under contract with Agilent should not have our PM machinery
       generating tasks and queue handoffs for visits we are not making. A
       LAPSED or unrecorded one still falls due, and going quiet about that is
       how a lapse becomes a failure. */
    expect(advisoryByCoverage("theirs")).toBe(true);
    expect(advisoryByCoverage("ours")).toBe(false);
    expect(advisoryByCoverage("lapsed")).toBe(false);
    expect(advisoryByCoverage("unknown")).toBe(false);
  });
});

describe("the landing stops counting shares as customers", () => {
  const read = (f: string) => readFileSync(f, "utf8");

  it("derives the header and the tile from coverage, not from row count", () => {
    const src = read("src/app/(dashboard)/page.tsx");
    expect(src).toMatch(/sub=\{coverageSummary\(/);
    // The two claims that were made from the count of visible systems.
    expect(src).not.toMatch(/\$\{rows\.length\} instrument.*under service/);
    expect(src).not.toMatch(/String\(rows\.length\), label: `instrument/);
  });

  it("reads the provider without resolving null to our own name", () => {
    // Null is what makes an agreement ours; resolving it here would erase the
    // distinction every state depends on.
    const src = read("src/app/(dashboard)/page.tsx");
    expect(src).toMatch(/providerName: a\.providerOrgId === null\s*\n?\s*\? null/);
  });

  it("never leaves a card silent about coverage", () => {
    const src = read("src/components/ClientLanding.tsx");
    expect(src).toMatch(/coverageLine\(s\.coverage, today\)/);
  });
});
