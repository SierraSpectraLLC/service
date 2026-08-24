// What a row on the board is trying to tell you, and in what colour.
//
// The dot is the only thing that survives the phone: the Stage and Attention
// columns are hidden under 900px, so on a phone the dot IS the row's status.
// That makes what feeds it load-bearing rather than decorative.
//
// The order is a priority, not a list. Down beats blocked because a system
// that cannot run is worse than one that is not moving; blocked beats the
// counting signals because "nobody can move this" outranks "there are three
// things to do on it". Everything below down is one quiet line of facts.
//
// Pure. The loader hands in the row.

import type { Tone } from "@/lib/tones";

export type BoardRow = {
  /** Days in "Waiting / blocked", or null when it is not blocked. */
  blockedDays: number | null;
  overdue: number;
  openParts: number;
  gasIssues: string[];
  assetIssues: string[];
  docIssues: string[];
  missingFromSheet: boolean;
  /** A work order or an asset says this system cannot run. */
  down: boolean;
  /** Ours to move, as opposed to parked with the client. */
  queueMine: boolean;
};

/**
 * Everything pulling at this system, as one quiet line rather than a pill wall.
 *
 * Blocked leads it. It was missing entirely, which is how a system marked
 * "Waiting / blocked" - the one stage that demands a written reason, the one
 * that means nobody is moving it - could sit on the board wearing the grey
 * dot for "ours to move". The age rides along because "blocked" and
 * "blocked 40d" are different problems.
 */
export function boardAttention(i: BoardRow): string[] {
  return [
    ...(i.blockedDays !== null ? [i.blockedDays > 0 ? `blocked ${i.blockedDays}d` : "blocked"] : []),
    ...(i.overdue > 0 ? [`${i.overdue} overdue`] : []),
    ...(i.openParts > 0 ? [`${i.openParts} open part${i.openParts === 1 ? "" : "s"}`] : []),
    ...i.gasIssues, ...i.assetIssues, ...i.docIssues,
    ...(i.missingFromSheet ? ["not on sheet"] : []),
  ];
}

/** The dot: down, then anything pulling at it, then whose move it is. */
export function boardTone(i: BoardRow): Tone {
  if (i.down) return "bad";
  if (boardAttention(i).length) return "warn";
  return i.queueMine ? "neutral" : "faint";
}
