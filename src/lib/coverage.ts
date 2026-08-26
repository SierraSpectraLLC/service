// Who services a system, and until when.
//
// VISIBILITY IS NOT A RELATIONSHIP. The client landing counted the systems an
// organization could see and announced every one of them as "under service
// with Sierra Spectra" - a system we had touched exactly once, a system whose
// real contract is with the manufacturer, and a system nobody has covered
// since 2025 all read the same. It is the queue mistake in another costume:
// the app had one kind of relationship in its model, so it assumed one.
//
// Pure, because the same answer has to appear in four places - the landing's
// header, each card, the record's own panel and the coverage list - and a
// second copy of this rule is a page that argues with itself about whether a
// client is a customer.

import type { Tone } from "@/lib/tones";
import { standing } from "@/lib/agreements";

/**
 * The four states, best first.
 *
 * The one that carries the design is the split at the bottom. LAPSED is a
 * thing we know: a contract covered this and ran out. UNKNOWN is the absence
 * of knowledge, and folding it into "uncovered" would be the same fabrication
 * as the claim this replaces, pointed the other way - we would be asserting
 * that no contract exists when all we can say is that we have not been shown
 * one. Same rule as the missing uptime figure and the "no history yet" median.
 */
export const COVERAGE_STATES = ["ours", "theirs", "lapsed", "unknown"] as const;
export type CoverageState = (typeof COVERAGE_STATES)[number];

export const COVERAGE: Record<CoverageState, { tone: Tone; rank: number }> = {
  ours: { tone: "good", rank: 0 },
  theirs: { tone: "info", rank: 1 },
  lapsed: { tone: "warn", rank: 2 },
  unknown: { tone: "neutral", rank: 3 },
};

/** An agreement, reduced to what decides coverage. */
export type CoverageAgreement = {
  id: number;
  title: string;
  number: string;
  status: string;
  startsOn: string;
  endsOn: string;
  renewNoticeDays: number;
  /** [] means every system the client has - see agreements.instrumentIds. */
  instrumentIds: number[];
  /** Null is us. Otherwise the name of whoever holds it. */
  providerName: string | null;
};

export type Coverage = {
  state: CoverageState;
  /** Who to call. Blank only when the state is unknown. */
  provider: string;
  /** The agreement behind the answer, when there is one. */
  agreementId: number | null;
  agreementTitle: string;
  /** When it ends, or ended. Blank for open-ended and for unknown. */
  endsOn: string;
  /** True while it is inside its own renewal-notice window. */
  expiring: boolean;
};

const UNKNOWN: Coverage = {
  state: "unknown", provider: "", agreementId: null, agreementTitle: "",
  endsOn: "", expiring: false,
};

/** [] on an agreement means the whole account, not "no systems". */
const namesSystem = (a: CoverageAgreement, systemId: number): boolean =>
  a.instrumentIds.length === 0 || a.instrumentIds.includes(systemId);

/**
 * What covers one system today.
 *
 * Live coverage wins over lapsed coverage, and ours wins over somebody else's
 * when both are live - not because ours matters more, but because it is the
 * one this instance can actually act on: a client reading "under contract with
 * Agilent" on a system we also cover would reasonably stop calling us.
 *
 * Where nothing is live, the most recently ENDED agreement is the answer, so
 * the sentence can be "Agilent's contract ended in March" rather than the
 * uselessly vague "not covered".
 */
export function coverageOf(
  systemId: number, agreements: CoverageAgreement[], today: string, operatorName: string,
): Coverage {
  const mine = agreements.filter((a) => namesSystem(a, systemId));
  if (mine.length === 0) return UNKNOWN;

  const live = mine
    .map((a) => ({ a, s: standing(a, today) }))
    .filter((x) => x.s === "active" || x.s === "expiring");
  if (live.length > 0) {
    // Ours first, then whichever runs longest - an open-ended one (blank
    // endsOn) outlasts every dated one, so it sorts to the front.
    const best = [...live].sort((x, y) => {
      const ax = x.a.providerName === null ? 0 : 1;
      const ay = y.a.providerName === null ? 0 : 1;
      if (ax !== ay) return ax - ay;
      if (!x.a.endsOn !== !y.a.endsOn) return x.a.endsOn ? 1 : -1;
      return y.a.endsOn.localeCompare(x.a.endsOn);
    })[0];
    return {
      state: best.a.providerName === null ? "ours" : "theirs",
      provider: best.a.providerName ?? operatorName,
      agreementId: best.a.id,
      agreementTitle: best.a.title || best.a.number || "Service agreement",
      endsOn: best.a.endsOn,
      expiring: best.s === "expiring",
    };
  }

  /* Nothing live. A draft is not coverage and never was, so it cannot lapse -
     it would report "your contract ended" about a contract that never
     started. Only something that ran, and stopped, counts. */
  const ended = mine
    .map((a) => ({ a, s: standing(a, today) }))
    .filter((x) => x.s === "expired" || x.s === "cancelled")
    .sort((x, y) => y.a.endsOn.localeCompare(x.a.endsOn));
  if (ended.length === 0) return UNKNOWN;

  const last = ended[0];
  return {
    state: "lapsed",
    provider: last.a.providerName ?? operatorName,
    agreementId: last.a.id,
    agreementTitle: last.a.title || last.a.number || "Service agreement",
    endsOn: last.a.endsOn,
    expiring: false,
  };
}

/**
 * The sentence a client reads about one system's coverage.
 *
 * Written to be true when read alone, because on a card it is: no "covered"
 * without saying by whom, and no claim at all where there is no record.
 */
export function coverageLine(c: Coverage, today: string): string {
  switch (c.state) {
    case "ours":
    case "theirs":
      return c.endsOn
        ? `Under service with ${c.provider} until ${c.endsOn}`
        : `Under service with ${c.provider} · open-ended`;
    case "lapsed":
      return c.endsOn && c.endsOn < today
        ? `${c.provider} coverage ended ${c.endsOn}`
        : `${c.provider} coverage has ended`;
    default:
      /* Not "not covered". We know we have not been shown a contract; we do
         not know that none exists, and the difference is a client being told
         their machine is unprotected on the strength of our filing. */
      return "No service contract on file";
  }
}

/** The short form, for a pill beside a system's name. */
export function coverageBadge(c: Coverage): string {
  switch (c.state) {
    case "ours": return "Under contract";
    case "theirs": return c.provider;
    case "lapsed": return "Contract lapsed";
    default: return "No contract on file";
  }
}

/**
 * The line under "Your lab", which used to claim every visible system.
 *
 * It counts rather than characterizes, and it names the operator only for the
 * systems the operator actually covers. An account where none of them are ours
 * gets a count and a plain statement of the gap, which is the honest version
 * of what that page has been saying.
 */
export function coverageSummary(
  states: CoverageState[], operatorName: string,
): string {
  const n = states.length;
  const unit = `${n} instrument${n === 1 ? "" : "s"}`;
  if (n === 0) return "No instruments on file yet";
  const ours = states.filter((s) => s === "ours").length;
  if (ours === n) return `${unit} under service with ${operatorName}`;
  if (ours === 0) return `${unit} · none under contract with ${operatorName}`;
  return `${unit} · ${ours} under service with ${operatorName}`;
}

/**
 * A system somebody else maintains should not have OUR maintenance machinery
 * running on it.
 *
 * instruments.pmMode already has the setting this needs: advisory keeps every
 * schedule - cadence, kit, history - and stops the machine acting on them, so
 * we neither generate tasks nor hand the system back and forth over a PM we
 * were never going to perform. Lapsed and unknown deliberately do NOT get this
 * treatment: an uncovered machine still falls due, and going quiet about it is
 * how a lapse turns into a failure.
 */
export const advisoryByCoverage = (state: CoverageState): boolean => state === "theirs";
