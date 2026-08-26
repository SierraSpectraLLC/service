// Built-in stage vocabulary. The live list (plus any custom stages and color
// overrides) is the stage_defs table, editable in Settings; these consts are
// the seed values and the fallback before the table is populated. The built-in
// NAMES are load-bearing: "Shipped", "Waiting / blocked", "Waiting to ship",
// and "Intake" are referenced by sync, dashboard counts, and the EOD report.
import type { Tone } from "@/lib/tones";

export const STAGES = [
  "Intake",
  "Refurbishment",
  "System setup",
  "Checkout",
  "Applications",
  "Sign-off",
  "Waiting / blocked",
  "Waiting to ship",
  "Shipped",
  // Past the refurbishment pipeline: a client's own instrument, working on their
  // bench, which we keep under contract. It is a resting state rather than a step
  // - a system sits in "In service" for years and steps out only when
  // maintenance falls due, which is what "Maintenance due" is for.
  "In service",
  "Maintenance due",
] as const;
export type Stage = (typeof STAGES)[number];

// Stages the client's sheet can express (sheetSync alias targets). Stage
// parity compares only these, so internal-only and custom stages never
// generate sheet diffs.
export const SHEET_STAGES = [
  "Intake", "Refurbishment", "System setup", "Checkout", "Applications", "Sign-off", "Shipped",
] as const;

/** Readable text color for a pill background: deep shade of the same hue on light, pale tint on dark. */
export function autoFg(bg: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(bg.trim());
  if (!m) return "#475569";
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  const mix = lum < 140
    ? (c: number) => Math.round(c + (255 - c) * 0.78)
    : (c: number) => Math.round(c * 0.42);
  return "#" + [r, g, b].map((c) => mix(c).toString(16).padStart(2, "0")).join("").toUpperCase();
}

export const GASES = ["Helium", "Nitrogen", "Argon", "Hydrogen", "Air"] as const;
export type Gas = (typeof GASES)[number];
// "Not connected" is a problem (system needs it, isn't hooked up);
// "Not needed" is inert (system doesn't use this gas) and never flags attention.
export const GAS_STATES = ["Connected", "Low", "Empty", "Not connected", "Not needed"] as const;
export const GAS_SYMBOL: Record<string, string> = {
  Helium: "He", Nitrogen: "N2", Argon: "Ar", Hydrogen: "H2", Air: "Air",
};
/* Dual-use: pills in the UI (via the tone classes) and chips in the digest
   email (via TONE_HEX, since mail clients read inline hex). "Not connected"
   is neutral yet still flags attention - see gasAttention below. */
export const GAS_TONE: Record<string, Tone> = {
  Connected: "good",
  Low: "warn",
  Empty: "bad",
  "Not connected": "neutral",
  "Not needed": "faint",
};
/** True when a gas status should surface on the dashboard / digest. */
export function gasAttention(status: string): boolean {
  return status === "Low" || status === "Empty" || status === "Not connected";
}

/**
 * The stage that means "this system is not moving".
 *
 * Load-bearing beyond its name: blocking is the one stage change that demands
 * a written reason (see toggleStage). A system marked blocked with no recorded
 * cause is a system nobody can unblock - it sits on the board looking urgent
 * while the one fact needed to act on it lives in somebody's memory.
 */
export const BLOCKED_STAGE = "Waiting / blocked";

/** Is this stage change the ACT of blocking - the moment a reason is owed? */
export const isBlocking = (current: string[], stage: string): boolean =>
  stage === BLOCKED_STAGE && !current.includes(stage);

/** A reason short enough to store, long enough to mean something. */
export const MAX_BLOCK_REASON = 300;
export const MIN_BLOCK_REASON = 4;
export const cleanBlockReason = (raw: string): string =>
  raw.trim().replace(/\s+/g, " ").slice(0, MAX_BLOCK_REASON);
export const validBlockReason = (raw: string): boolean =>
  cleanBlockReason(raw).length >= MIN_BLOCK_REASON;

export const TASK_STATES = ["Open", "In progress", "Blocked", "Done"] as const;
/**
 * TWO WAYS A PART ARRIVES, and only one of them was ever in here.
 *
 * The list was a procurement pipeline end to end - ordered, shipped, received -
 * which is right until a client decides to stop buying a bracket and start
 * printing it. Then every word is wrong: nothing is on order, no carrier has
 * it, and it will never be "received" because nobody is sending it. The only
 * honest options left were to leave it sitting on "Needed" for three weeks
 * while somebody made it, or to lie about an order.
 *
 * So there are two lanes now, sharing both ends. "Needed" is still the moment
 * of commitment and it does not care which way the part comes; "Installed" and
 * "Removed" are still how it ends. Between them a part is either BOUGHT
 * (Ordered -> In transit -> Received, with Backordered as the stall) or MADE
 * (Being made -> Made). The two never mix on one row, which is what makes
 * either lane readable on a board.
 *
 * "Suggested" comes before commitment: the engineer diagnosing thinks the
 * switch assembly is the fix, but nobody has agreed to buy - or make -
 * anything yet. It never counts against a parts allowance (lib/agreementUsage
 * counts Installed) and never trips the entitlement flag; promoting it to
 * Needed is the moment of commitment, and that is where the machinery wakes up.
 */
export const PART_STATES = [
  "Suggested", "Needed",
  "Ordered", "In transit", "Received", "Backordered",
  "Being made", "Made",
  "Installed", "Removed",
] as const;

/**
 * True while a part still needs someone to do something (order, make, chase,
 * install).
 *
 * "Made" closes for the same reason "Received" does: the part exists and is in
 * somebody's hand, and the only thing left is fitting it - which is the
 * install step, not a chase. A part still on the printer is emphatically open.
 */
export function partOpen(status: string): boolean {
  return status !== "Received" && status !== "Made"
    && status !== "Installed" && status !== "Removed";
}
/** Statuses where PO/carrier/tracking/ordered/ETA are relevant - the form hides them otherwise. */
export const ORDER_STATES = ["Ordered", "In transit", "Received", "Backordered"] as const;
/**
 * Statuses where somebody is FABRICATING the part rather than buying it - the
 * lane where "who is making it" is the question and a PO number is not.
 *
 * The mirror of ORDER_STATES, and used the same way: the form shows the maker
 * here and the order paperwork there, so one row never carries both a tracking
 * number and a print job.
 */
export const MAKE_STATES = ["Being made", "Made"] as const;

export const isMadeState = (status: string): boolean =>
  (MAKE_STATES as readonly string[]).includes(status);
export const CARRIERS = ["", "UPS", "FedEx", "USPS", "DHL", "Freight", "Other"] as const;
export const ATTACH_KINDS = ["Tune report", "Test data", "Report", "Photo", "Manual", "Other"] as const;

/** Asset kinds - LC stack components, GC front ends, MS pieces. */
export const MODULE_KINDS = [
  "Pump", "Autosampler", "Column oven", "Detector", "Mass spec", "Degasser",
  "Controller", "Headspace", "GC", "Injector", "Vacuum pump", "Computer", "Other",
] as const;

// "Spare" is unattached-but-fine; "Decommissioned" is end of life.
export const ASSET_STATES = ["In service", "Spare", "Needs attention", "Down", "Decommissioned"] as const;
export const ASSET_TONE: Record<string, Tone> = {
  "In service": "good",
  Spare: "neutral",
  "Needs attention": "warn",
  Down: "bad",
  Decommissioned: "faint",
};
/** True when an asset status should surface on the system row / dashboard. */
/**
 * May this stage be put on, or taken off, a record?
 *
 * Asymmetric on purpose. ADDING is restricted to the defined vocabulary, which is
 * what stops "Chekout" existing beside "Checkout". REMOVING is always allowed for
 * a stage the record already carries, defined or not - and that asymmetry is the
 * whole point of this function.
 *
 * The bug it closes: "Maintenance due" is put on a system by code, not by a
 * person - a client reports a fault, or a PM falls due. It was added to the
 * built-in list long after the stage table had been seeded, so it lived on
 * systems while being absent from the vocabulary, and taking it off threw
 * "Unknown stage" - a crash page, on the one stage people most need to clear.
 *
 * Seeding the two missing rows fixes today. This fixes it for good: a stage on a
 * record is evidence that it is a real stage, whatever the table currently says,
 * and refusing to let go of something you can see is never the right answer.
 */
export function stageChange(
  current: string[], stage: string, known: string[],
): { ok: true; next: string[] } | { ok: false; error: string } {
  const has = current.includes(stage);
  if (has) {
    if (current.length === 1) {
      return { ok: false, error: "A system keeps at least one stage - add another first." };
    }
    return { ok: true, next: current.filter((s) => s !== stage) };
  }
  if (!known.includes(stage)) {
    return { ok: false, error: `"${stage}" is not one of this workspace's stages.` };
  }
  return { ok: true, next: [...current, stage] };
}

export function assetAttention(status: string): boolean {
  return status === "Needs attention" || status === "Down";
}

// Matched to the client sheet's dropdown chips (their "Waiting" = our
// "Waiting / blocked"; their "Packing" purple = our "Waiting to ship").
export const STAGE_COLOR: Record<string, { bg: string; fg: string }> = {
  Intake: { bg: "#F9CB9C", fg: "#783F04" },
  Refurbishment: { bg: "#FFE599", fg: "#7F6000" },
  "System setup": { bg: "#C9DAF8", fg: "#1C4587" },
  Checkout: { bg: "#B6E2A1", fg: "#2C5E1A" },
  Applications: { bg: "#E69138", fg: "#2E1C05" },
  "Sign-off": { bg: "#E5F3E5", fg: "#2E6B2E" },
  "Waiting / blocked": { bg: "#F4CCCC", fg: "#B42318" },
  "Waiting to ship": { bg: "#D9D2E9", fg: "#674EA7" },
  Shipped: { bg: "#38761D", fg: "#D9EAD3" },
  "In service": { bg: "#E4F0E4", fg: "#2E6B2E" },
  "Maintenance due": { bg: "#FAF0DC", fg: "#8A5410" },
};
export const TASK_TONE: Record<string, Tone> = {
  Open: "neutral",
  "In progress": "info",
  Blocked: "bad",
  Done: "good",
};
/* Installed was a teal of its own; it now shares `good` with Received - the
   distinction the teal carried is already in the word. */
export const PART_TONE: Record<string, Tone> = {
  Suggested: "warn",
  Needed: "neutral",
  Ordered: "accent",
  "In transit": "info",
  Received: "good",
  Backordered: "bad",
  // The made lane borrows the bought lane's tones rather than inventing two
  // more: work in somebody's hands reads the same whether it is on a truck or
  // on a printer, and a part that exists reads the same however it got here.
  "Being made": "info",
  Made: "good",
  Installed: "good",
  Removed: "neutral",
};
export const ATTACH_META: Record<string, { glyph: string; tone: Tone }> = {
  "Tune report": { glyph: "⚙", tone: "accent" },
  "Test data": { glyph: "▤", tone: "info" },
  Report: { glyph: "▦", tone: "good" },
  Photo: { glyph: "▣", tone: "warn" },
  Manual: { glyph: "▥", tone: "neutral" },
  Other: { glyph: "▢", tone: "neutral" },
};

export function trackUrl(carrier: string, n: string): string | null {
  if (!n) return null;
  const t = n.replace(/\s+/g, "");
  switch (carrier) {
    case "UPS": return "https://www.ups.com/track?tracknum=" + t;
    case "FedEx": return "https://www.fedex.com/fedextrack/?trknbr=" + t;
    case "USPS": return "https://tools.usps.com/go/TrackConfirmAction?tLabels=" + t;
    case "DHL": return "https://www.dhl.com/en/express/tracking.html?AWB=" + t;
    default: return null;
  }
}
