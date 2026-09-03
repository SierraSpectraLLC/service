// Turning a list of handoffs back into spans of custody.
//
// custody_events records MOMENTS - "LabZen handed this to Emery on Mar 3" - and
// every question worth asking is about the span between two of them: who held
// it when this PM was done, what did this holder's tenure contain, where is the
// gap nobody sealed. Reconstructing that at each call site is how five surfaces
// end up with five slightly different answers about the same machine.
//
// Pure, so Phase 2 (stamping an event with the custodian at the time) and Phase
// 3 (backfilling custody_epochs) cannot disagree about where a span begins.

import type { CloseKind, OrgId } from "@/lib/custody/types";

/** custody_events, narrowed. `at` is when the machine moved. */
export type CustodyRow = {
  id: number;
  /** intake | transfer | claim | release */
  kind: string;
  fromOrgId: OrgId | null;
  toOrgId: OrgId | null;
  fromName: string;
  toName: string;
  at: Date;
};

export type Span = {
  /** 1-based, dense. Epoch numbering, and the anchor comparison, run on this. */
  n: number;
  /** Null is house stewardship - real, and not a missing value. */
  custodianOrgId: OrgId | null;
  custodianName: string;
  from: Date;
  /** Null = still open. */
  to: Date | null;
  openedByRowId: number;
  closedByRowId: number | null;
  closeKind: CloseKind;
};

/**
 * The spans, oldest first.
 *
 * THE TIME BEFORE THE FIRST ROW IS NOT A SPAN. Every owned system was
 * backfilled with one `intake` row, so the stretch before it is the stretch
 * before this platform existed - it is somebody's history and we have none of
 * it, and inventing an epoch for it would put a custodian's name on years
 * nobody here can account for. It reads as "before Ridgeline" and that is the
 * honest answer.
 *
 * `currentCustodianOrgId` closes the argument about the last span: the pointer
 * on the instrument row is what every existing surface believes today, so the
 * open span carries it even when the last handoff disagrees. A disagreement is
 * a real finding and scripts/custody-parity is what reports it - silently
 * preferring one of the two would hide it.
 */
export function spansOf(
  rows: CustodyRow[],
  current: { custodianOrgId: OrgId | null; custodianName: string },
): Span[] {
  const ordered = [...rows].sort((a, b) => a.at.getTime() - b.at.getTime() || a.id - b.id);
  const spans: Span[] = [];
  for (const [i, r] of ordered.entries()) {
    const next = ordered[i + 1] ?? null;
    spans.push({
      n: i + 1,
      custodianOrgId: r.toOrgId,
      custodianName: r.toName,
      from: r.at,
      to: next ? next.at : null,
      openedByRowId: r.id,
      closedByRowId: next ? next.id : null,
      // A span that ended is sealed as far as this backfill can tell; only a
      // claim knows it was a claim. Phase 5 writes the richer kinds going
      // forward - see closeKindFor, which is the one place that decides.
      closeKind: next ? closeKindFor(next.kind) : "open",
    });
  }
  if (spans.length) {
    const last = spans[spans.length - 1];
    last.custodianOrgId = current.custodianOrgId;
    last.custodianName = current.custodianName || last.custodianName;
  }
  return spans;
}

/** What the handoff that CLOSED a span says about how it closed. */
export function closeKindFor(nextRowKind: string): CloseKind {
  return nextRowKind === "claim" ? "claimed" : "sealed";
}

/**
 * Who held the machine at a moment.
 *
 * Before the first span, null: not "the first owner, probably". A PM dated two
 * years before the earliest handoff on file belongs to somebody this platform
 * has never met, and attributing it to whoever came first would put another
 * shop's work under a name that did not do it.
 */
export function custodianAt(spans: Span[], at: Date): { orgId: OrgId | null; name: string } {
  const t = at.getTime();
  for (const s of spans) {
    if (t < s.from.getTime()) continue;
    if (s.to === null || t < s.to.getTime()) return { orgId: s.custodianOrgId, name: s.custodianName };
  }
  // Past the end of a closed final span cannot happen (the last span is open),
  // and before the first is the honest hole above.
  return { orgId: null, name: "" };
}

/**
 * The span a moment falls in, for stamping an event with its epoch.
 *
 * A HANDOFF INSTANT BELONGS TO TWO SPANS AND THE ANSWER DIFFERS BY EVENT.
 *
 *   'opens'  - work recorded at the moment the machine moved was done for the
 *              incoming holder. The default, and what every ordinary event
 *              wants.
 *   'closes' - the handoff itself terminates the OUTGOING tenure, so it belongs
 *              to that one. This is not a nicety: sealing freezes a bundle over
 *              the events of the epoch being closed, and the transfer is the
 *              last line of the record its holder hands over. Phase 5 appends
 *              it before the close for exactly this reason, and a backfill that
 *              filed old handoffs the other way would leave two conventions in
 *              one table.
 *
 * The first span has nothing before it, so an intake falls back to opening.
 */
export function spanAt(spans: Span[], at: Date, boundary: "opens" | "closes" = "opens"): Span | null {
  const t = at.getTime();
  if (boundary === "closes") {
    const closed = spans.find((s) => s.to !== null && s.to.getTime() === t);
    if (closed) return closed;
  }
  for (const s of spans) {
    if (t < s.from.getTime()) continue;
    if (s.to === null || t < s.to.getTime()) return s;
  }
  return null;
}

/** Handoff kinds, whose events close the tenure they end rather than open one. */
export const CLOSES_A_SPAN = new Set(["transfer", "claim", "release"]);
