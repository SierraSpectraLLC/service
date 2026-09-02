// How much a line in a machine's history is worth, decided when it is written.
//
// Two axes, both recorded and neither inferred at read time. WHO says it
// happened, and HOW it was recorded. A buyer reading a chain six years and
// three owners later cannot tell a measured leak-rate from a ticked box, and
// the shop that ticked the box has no reason to volunteer the difference - so
// the difference is graded at the moment somebody knows it, the same bet
// lib/provenance makes about catalog text and lib/signoff.signoffGate makes
// about evidence.
//
// Pure. The score itself is Phase 8; what lives here are the weights it will
// use, named, so the grades and the money they eventually move are defined in
// one file rather than discovered in a spreadsheet.

import type { CloseKind, HandoffGrade, HowGrade, OrgId, WhoGrade } from "@/lib/custody/types";

export type { HandoffGrade, HowGrade, WhoGrade };

/**
 * WHO. The custodian's own staff is `self_reported`; an outside org working
 * under a grant is `third_party`; anything asserted about work the platform did
 * not see happen is `attested`.
 *
 * `backfilled` here means ASSERTED, not migrated: a binder that came with the
 * machine, a seller's word at intake. Rows migrated out of this app's own
 * tables are not attested - the shop that typed them did the work - and
 * scripts/backfill-system-events passes backfilled: false for exactly that
 * reason.
 *
 * `authorVerified` is undefined before orgs.verified_at exists (Phase 4), and
 * distinctness alone decides. From Phase 4 the real flag is passed and an
 * unverified outside author grades DOWN to self_reported: an org grading its
 * own subsidiary as third-party is the obvious way to buy a score, and the
 * cheap direction to be wrong in is the modest one.
 */
export function whoGradeFor(input: {
  authorOrgId: OrgId | null;
  custodianOrgId: OrgId | null;
  backfilled: boolean;
  authorVerified?: boolean;
}): WhoGrade {
  if (input.backfilled) return "attested";
  if (input.authorOrgId === null) return "self_reported";
  if (input.authorOrgId === input.custodianOrgId) return "self_reported";
  if (input.authorVerified === false) return "self_reported";
  return "third_party";
}

/**
 * HOW. Evidence, counted - never the shape of the form somebody filled in.
 *
 * A procedure run leaves readings or ticked steps behind. Typed is a sentence
 * somebody wrote afterwards, which is most of the history in this app and is
 * worth having. Document-only is a file and nothing structured: real, weakest,
 * and the honest grade for most of what arrives with a used machine.
 */
export function howGradeFor(evidence: {
  /** task_results rows against the work. */
  results: number;
  /** Checklist items actually ticked. */
  checklistDone: number;
  /** Characters of written close-out or note. */
  written: number;
  /** A report, scan or certificate is on file. */
  documents?: number;
}): HowGrade {
  if (evidence.results > 0 || evidence.checklistDone > 0) return "procedure_run";
  if (evidence.written > 0) return "typed";
  return (evidence.documents ?? 0) > 0 ? "document_only" : "typed";
}

/** How an epoch ended, as it reads downstream. Null while it is still open. */
export function handoffGradeFor(closeKind: CloseKind): HandoffGrade | null {
  return closeKind === "open" ? null
    : closeKind === "dormant" ? "dormant_gap"
    : closeKind === "claimed" ? "closed_by_claim"
    : closeKind;
}

/**
 * THE WEIGHTS. Named here, applied in Phase 8's score.
 *
 * Written down now because the grades and their price have to be one decision:
 * defining "third_party" in one file and deciding what it is worth in another,
 * months later, is how a grade ends up meaning whatever the score needed it to
 * mean. Nothing reads these yet.
 */
export const SCORE_WEIGHTS = {
  /** An event's base worth by who said it. */
  who: { third_party: 3, self_reported: 2, attested: 1 } satisfies Record<WhoGrade, number>,
  /** Multiplied by the who-weight: a ticked box does not price like a reading. */
  how: { procedure_run: 1, typed: 0.6, document_only: 0.3 } satisfies Record<HowGrade, number>,
  /**
   * What a closed epoch keeps of its own events. A dormant gap is the one that
   * has to bite: nobody sealed, so nothing about that span was ever reviewed,
   * and a chain that priced it like a clean handoff would pay people to
   * disappear rather than seal.
   */
  close: { sealed: 1, steward_sealed: 0.85, closed_by_claim: 0.6, dormant_gap: 0.25 } satisfies Record<HandoffGrade, number>,
  /** Work halves in weight every this many days. Old PMs are true, not current. */
  recencyHalfLifeDays: 730,
  /** An open epoch is not yet sealed and cannot be scored as if it were. */
  openEpochFactor: 0.9,
  max: 100,
} as const;
