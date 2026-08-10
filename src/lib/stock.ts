// Inventory rules, kept pure so they're testable without a database: who may
// see or draw from a room, when a line is below its floor, and whether a draw
// is even possible. The DB gates in app/actions wrap these.
import { normalizePn } from "@/lib/priceBook";
import type { Role } from "@/lib/authz";
import { isHouse } from "@/lib/tenancy";

export const STOCK_KINDS = ["shop", "client", "mobile"] as const;

export const KIND_LABEL: Record<string, string> = {
  shop: "Shop shelf",
  client: "Client cage",
  mobile: "Van / field kit",
};

export const MOVE_KINDS = ["receive", "issue", "adjust", "transfer_in", "transfer_out", "return"] as const;

export const MOVE_LABEL: Record<string, string> = {
  receive: "Received",
  issue: "Issued",
  adjust: "Recount",
  transfer_in: "Transferred in",
  transfer_out: "Transferred out",
  return: "Returned",
};

export type StockLine = { qty: number; minQty: number };

/**
 * Below the floor. A zero floor means nobody has decided one, so it never
 * reports short - a shelf of one-off spares shouldn't drown the reorder list.
 */
export function needsReorder(line: StockLine): boolean {
  return line.minQty > 0 && line.qty <= line.minQty;
}

/** How many to buy to get back to the floor. At least one when short at all. */
export function shortBy(line: StockLine): number {
  if (!needsReorder(line)) return 0;
  return Math.max(1, line.minQty - line.qty);
}

/** Reorder list, emptiest-relative-to-its-floor first. */
export function reorderLines<T extends StockLine>(lines: T[]): T[] {
  return lines.filter(needsReorder).sort((a, b) => {
    const ra = a.minQty === 0 ? 1 : a.qty / a.minQty;
    const rb = b.minQty === 0 ? 1 : b.qty / b.minQty;
    return ra - rb || shortBy(b) - shortBy(a);
  });
}

export function stockTotals(lines: StockLine[]): { lines: number; units: number; short: number } {
  return {
    lines: lines.length,
    units: lines.reduce((n, l) => n + l.qty, 0),
    short: lines.filter(needsReorder).length,
  };
}

/**
 * Can this many come off the shelf? Refusing to go negative is deliberate: an
 * impossible count means the shelf and the record already disagree, and a
 * recount (which says so, with a reason) is the honest fix - not a silent
 * negative that quietly corrupts every reorder decision downstream.
 */
export function canIssue(onHand: number, want: number): { ok: true } | { ok: false; error: string } {
  if (!Number.isInteger(want) || want <= 0) return { ok: false, error: "How many? Whole numbers above zero." };
  if (want > onHand) {
    return { ok: false, error: `Only ${onHand} on hand. Recount first if the shelf disagrees.` };
  }
  return { ok: true };
}

export type StockViewer = { role: Role; orgId: number | null };

/**
 * What a viewer may do with one room.
 * - the house sees and works everything
 * - the room's own organization sees it and its editors draw from it; only its
 *   editors may rename it, set floors or hand out access
 * - another organization sees it only through a share, and draws from it only
 *   on an 'issue' share - and never as a viewer-role account, because drawing
 *   stock is a write however generous the share is
 */
export function stockAccess(
  viewer: StockViewer,
  room: { orgId: number | null },
  share: { access: string } | undefined,
): { see: boolean; issue: boolean; manage: boolean } {
  if (isHouse(viewer.role)) return { see: true, issue: true, manage: true };
  const canWrite = viewer.role === "client_editor";
  if (viewer.orgId !== null && room.orgId === viewer.orgId) {
    return { see: true, issue: canWrite, manage: canWrite };
  }
  if (!share) return { see: false, issue: false, manage: false };
  return { see: true, issue: canWrite && share.access === "issue", manage: false };
}

/** Match an on-hand line to a part number the way the price book would. */
export function findLine<T extends { partNumber: string }>(lines: T[], pn: string): T | undefined {
  const key = normalizePn(pn);
  if (!key) return undefined;
  return lines.find((l) => normalizePn(l.partNumber) === key);
}
