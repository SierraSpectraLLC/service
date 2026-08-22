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
// "Suggested" comes before commitment: the engineer diagnosing thinks the
// switch assembly is the fix, but nobody has agreed to buy anything yet. It
// never counts against a parts allowance (lib/agreementUsage counts Installed)
// and never trips the entitlement flag - promoting it to Needed is the moment
// of commitment, and that is where the machinery wakes up.
export const PART_STATES = ["Suggested", "Needed", "Ordered", "In transit", "Received", "Backordered", "Installed", "Removed"] as const;
/** True while a part still needs someone to do something (order, chase, install). */
export function partOpen(status: string): boolean {
  return status !== "Received" && status !== "Installed" && status !== "Removed";
}
/** Statuses where PO/carrier/tracking/ordered/ETA are relevant - the form hides them otherwise. */
export const ORDER_STATES = ["Ordered", "In transit", "Received", "Backordered"] as const;
export const CARRIERS = ["", "UPS", "FedEx", "USPS", "DHL", "Freight", "Other"] as const;
export const ATTACH_KINDS = ["Tune report", "Test data", "Report", "Photo", "Manual", "Other"] as const;

/** Asset kinds - LC stack components, GC front ends, MS pieces. */
export const MODULE_KINDS = [
  "Pump", "Autosampler", "Column oven", "Detector", "Mass spec", "Degasser",
  "Controller", "Headspace", "GC", "Injector", "Vacuum pump", "Computer", "Other",
] as const;

// "Spare" is unattached-but-fine; "Decommissioned" is end of life.
export const ASSET_STATES = ["In service", "Spare", "Needs attention", "Down", "Decommissioned"] as const;
export const ASSET_COLOR: Record<string, { bg: string; fg: string }> = {
  "In service": { bg: "#E5F3E5", fg: "#2E6B2E" },
  Spare: { bg: "#EEF1F5", fg: "#475569" },
  "Needs attention": { bg: "#FAF0DC", fg: "#8A5410" },
  Down: { bg: "#FBE9E9", fg: "#A32D2D" },
  Decommissioned: { bg: "#EEF1F5", fg: "#94A3B8" },
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
export const PART_COLOR: Record<string, { bg: string; fg: string }> = {
  Suggested: { bg: "#FAF0DC", fg: "#8A5410" },
  Needed: { bg: "#EEF1F5", fg: "#475569" },
  Ordered: { bg: "#EDEBFA", fg: "#4F45A3" },
  "In transit": { bg: "#E7F2FA", fg: "#1D6396" },
  Received: { bg: "#E5F3E5", fg: "#2E6B2E" },
  Backordered: { bg: "#FBE9E9", fg: "#A32D2D" },
  Installed: { bg: "#DDF0EA", fg: "#085041" },
  Removed: { bg: "#EEF1F5", fg: "#64748B" },
};
export const ATTACH_META: Record<string, { glyph: string; bg: string; fg: string }> = {
  "Tune report": { glyph: "⚙", bg: "#EDEBFA", fg: "#4F45A3" },
  "Test data": { glyph: "▤", bg: "#E7F2FA", fg: "#1D6396" },
  Report: { glyph: "▦", bg: "#E5F3E5", fg: "#2E6B2E" },
  Photo: { glyph: "▣", bg: "#FAF0DC", fg: "#8A5410" },
  Manual: { glyph: "▥", bg: "#FBEAE3", fg: "#A33A1A" },
  Other: { glyph: "▢", bg: "#EEF1F5", fg: "#475569" },
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
