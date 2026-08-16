// The compliance half of a regulated (GxP) system.
//
// Everything here hangs off one switch, instruments.gxp: off, none of it
// renders and a loaner UV-Vis never sees the word "IQ". On, three questions
// get answers the auditor's way:
//
//   - which qualification does this work belong to (IQ/OQ/PQ, a tag on the
//     procedures that already exist - not a parallel object to maintain)
//   - which documents are about to stop being current (a validity date on the
//     files that already exist)
//   - is this system qualified RIGHT NOW (derived, never stored - the same
//     rule as agreement balances: a stored status is a status that drifts)
//
// Pure. Pages hand in rows; this decides what they mean.

import { gasesForSystemWithUnits } from "@/lib/catalogGas";

/** The order they run in, which is also the order the binder prints them. */
export const QUALIFICATIONS = ["IQ", "OQ", "PQ"] as const;

export const QUAL_LABEL: Record<string, string> = {
  IQ: "Installation Qualification",
  OQ: "Operational Qualification",
  PQ: "Performance Qualification",
};

// ---------------------------------------------------------------------------
// Expiring documents

export type Dated = { expiresOn: string };

/** Days from `today` (shop-day string) to the date; negative = already past. */
export function daysUntil(date: string, today: string): number {
  const d = new Date(`${date}T00:00:00Z`).getTime();
  const t = new Date(`${today}T00:00:00Z`).getTime();
  return Math.round((d - t) / 86_400_000);
}

/**
 * Split dated documents into expired and expiring-soon.
 *
 * 60 days of warning, because a replacement cert is usually somebody else's
 * calendar - a vendor visit, a calibration service - and 2 weeks of notice is
 * how a lapse happens anyway with extra steps. Undated documents never nag.
 */
export function expiryAttention<T extends Dated>(
  docs: T[], today: string, horizonDays = 60,
): { expired: T[]; soon: T[] } {
  const expired: T[] = [];
  const soon: T[] = [];
  for (const d of docs) {
    if (!d.expiresOn) continue;
    const days = daysUntil(d.expiresOn, today);
    if (days < 0) expired.push(d);
    else if (days <= horizonDays) soon.push(d);
  }
  return { expired, soon };
}

/** "expired 12d ago" / "expires in 30d" / "expires today" - the chip text. */
export function expiryLabel(date: string, today: string): string {
  const days = daysUntil(date, today);
  if (days < 0) return `expired ${-days}d ago`;
  if (days === 0) return "expires today";
  return `expires in ${days}d`;
}

// ---------------------------------------------------------------------------
// Qualification standing

export type StandingInput = {
  /**
   * Per qualification that applies to this system: whether every piece of its
   * generated work is Done. A qualification with no procedures declared simply
   * doesn't appear - absence of evidence is "not qualified" only for the quals
   * the catalog actually asks of this equipment.
   */
  quals: { qualification: string; open: number; done: number }[];
  /** Expired dated documents on the record. */
  expired: number;
  /** Dated documents inside the warning horizon. */
  expiringSoon: number;
  /**
   * Validation-package completeness, when the doc manager is in play. Null
   * means no package is declared for this equipment, which is not a failure -
   * a shop can run the qualification tags without the document manager.
   */
  packageComplete: boolean | null;
};

export type Standing = {
  label: "Qualified" | "Not qualified" | "Attention";
  tone: "ok" | "bad" | "warn";
  /** Why, one line each, in the order a reviewer would want them. */
  reasons: string[];
};

/**
 * A regulated system's standing, derived from the record.
 *
 * "Not qualified" is reserved for the hard gaps - qualification work never
 * completed, or a declared package with holes. Expiries and requal work in
 * flight are "Attention": the system WAS qualified and something is lapsing,
 * which is a different conversation than never having been qualified at all.
 */
export function qualStanding(s: StandingInput): Standing {
  const reasons: string[] = [];
  let notQualified = false;

  for (const q of s.quals) {
    if (q.done === 0 && q.open > 0) {
      notQualified = true;
      reasons.push(`${q.qualification} has never been completed (${q.open} open)`);
    } else if (q.open > 0) {
      reasons.push(`${q.qualification} rework open (${q.open} task${q.open === 1 ? "" : "s"})`);
    }
  }
  if (s.packageComplete === false) {
    notQualified = true;
    reasons.push("validation package incomplete");
  }
  if (s.expired > 0) reasons.push(`${s.expired} document${s.expired === 1 ? "" : "s"} expired`);
  if (s.expiringSoon > 0) reasons.push(`${s.expiringSoon} expiring soon`);

  if (notQualified) return { label: "Not qualified", tone: "bad", reasons };
  if (reasons.length) return { label: "Attention", tone: "warn", reasons };
  return { label: "Qualified", tone: "ok", reasons };
}

/** Group a system's qualification-tagged tasks into StandingInput.quals. */
export function qualsOf(tasks: { qualification: string; state: string }[]): StandingInput["quals"] {
  return QUALIFICATIONS.flatMap((q) => {
    const mine = tasks.filter((t) => t.qualification === q);
    if (!mine.length) return [];
    const done = mine.filter((t) => t.state === "Done").length;
    return [{ qualification: q, open: mine.length - done, done }];
  });
}

export const STANDING_COLOR: Record<Standing["tone"], { bg: string; fg: string }> = {
  ok: { bg: "#E5F3E5", fg: "#2E6B2E" },
  warn: { bg: "#FAF0DC", fg: "#8A5410" },
  bad: { bg: "#FBE9E9", fg: "#A32D2D" },
};

// ---------------------------------------------------------------------------
// Validation documents

/** Binder order, which is also checklist order: plan, protocols, evidence. */
export const DOC_TYPES = [
  "URS", "Validation Plan",
  "IQ Protocol", "IQ Report",
  "OQ Protocol", "OQ Report",
  "PQ Protocol", "PQ Report",
  "Traceability Matrix", "Deviation Report", "Periodic Review",
  "Calibration Certificate", "Other",
] as const;

/**
 * A protocol is approved before it is run; everything else is approved after
 * it is written. The distinction is what "Executed" exists for.
 */
export const isProtocol = (docType: string) => /protocol$/i.test(docType.trim());

export const DOC_STATES = ["Draft", "Approved", "Executed", "Superseded"] as const;

export const DOC_STATE_COLOR: Record<string, { bg: string; fg: string }> = {
  Draft: { bg: "#EEF1F5", fg: "#475569" },
  Approved: { bg: "#E5F3E5", fg: "#2E6B2E" },
  Executed: { bg: "#E7F2FA", fg: "#1D6396" },
  Superseded: { bg: "#F1F4F8", fg: "#94A3B8" },
};

/** In signing order. The Approved signature is what moves a Draft forward. */
export const SIG_ROLES = ["Author", "Reviewed", "Approved"] as const;

export type ValidationDocLike = {
  docType: string;
  state: string;
};

/**
 * What may happen to a document in its current state. Small and explicit,
 * because these rules ARE the compliance claim:
 *
 *  - only a Draft can be approved (approving Executed paper rewrites history)
 *  - only an Approved PROTOCOL can be marked executed
 *  - an approval can be withdrawn while Approved, never once Executed - after
 *    execution the record moves forward by superseding, not by un-signing
 *  - only an unsigned Draft may be deleted; everything else supersedes
 */
export const canApprove = (d: ValidationDocLike) => d.state === "Draft";
export const canExecute = (d: ValidationDocLike) => d.state === "Approved" && isProtocol(d.docType);
export const canRevokeApproval = (d: ValidationDocLike) => d.state === "Approved";
export const canDelete = (d: ValidationDocLike, signatures: number) => d.state === "Draft" && signatures === 0;

/** A required doc type is satisfied by a current Approved or Executed document. */
export const docSatisfies = (d: ValidationDocLike) => d.state === "Approved" || d.state === "Executed";

export type PackageRow<D extends ValidationDocLike> = {
  docType: string;
  /** Current (non-superseded) documents of this type, newest version first. */
  docs: D[];
  satisfied: boolean;
  required: boolean;
};

/**
 * The checklist: required doc types in binder order, each with its current
 * documents, then whatever else is on file. Superseded revisions are history,
 * not checklist entries - they live under their successor.
 */
export function packageRows<D extends ValidationDocLike & { version: number }>(
  required: string[], docs: D[],
): PackageRow<D>[] {
  const current = docs.filter((d) => d.state !== "Superseded");
  const typeOrder = (t: string) => {
    const i = (DOC_TYPES as readonly string[]).findIndex((x) => x.toLowerCase() === t.toLowerCase());
    return i === -1 ? DOC_TYPES.length : i;
  };
  const ofType = (t: string) =>
    current.filter((d) => d.docType.toLowerCase() === t.toLowerCase()).sort((a, b) => b.version - a.version);

  const rows: PackageRow<D>[] = required.map((t) => ({
    docType: t, docs: ofType(t), satisfied: ofType(t).some(docSatisfies), required: true,
  }));
  const extraTypes = [...new Set(current.map((d) => d.docType))]
    .filter((t) => !required.some((r) => r.toLowerCase() === t.toLowerCase()))
    .sort((a, b) => typeOrder(a) - typeOrder(b));
  rows.push(...extraTypes.map((t) => ({ docType: t, docs: ofType(t), satisfied: true, required: false })));
  return rows;
}

/** Null when nothing is required - a shop can run GxP without the doc manager. */
export function packageComplete(required: string[], docs: ValidationDocLike[]): boolean | null {
  if (!required.length) return null;
  return packageRows(required, docs.map((d) => ({ ...d, version: 1 }))).every((r) => !r.required || r.satisfied);
}

export type PackageTerm = {
  kind: string; assetType: string; name: string; docTypes: string[];
};

/**
 * The package a system owes, from the catalog: its system type's doc types
 * plus those of every unit installed in it. Same declare-once matching as gas
 * requirements - gasesForSystemWithUnits IS the matcher, fed docTypes instead
 * of gases - then sorted into binder order so the checklist reads like the
 * binder will print.
 */
export function packageForSystem(
  terms: PackageTerm[], category: string, units: { kind: string; model: string }[],
): string[] {
  const order = (t: string) => {
    const i = (DOC_TYPES as readonly string[]).findIndex((x) => x.toLowerCase() === t.toLowerCase());
    return i === -1 ? DOC_TYPES.length : i;
  };
  return gasesForSystemWithUnits(
    terms.map((t) => ({ kind: t.kind, assetType: t.assetType, name: t.name, gases: t.docTypes })),
    category, units,
  ).sort((a, b) => order(a) - order(b));
}
