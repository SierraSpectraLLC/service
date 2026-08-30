// Inventory rules, kept pure so they're testable without a database: who may
// see or draw from a room, when a line is below its floor, and whether a draw
// is even possible. The DB gates in app/actions wrap these.
import { normalizePn } from "@/lib/priceBook";
import type { Role } from "@/lib/authz";
import { houseOfRecord } from "@/lib/tenants";

export const STOCK_KINDS = ["shop", "client", "mobile"] as const;

export const KIND_LABEL: Record<string, string> = {
  shop: "Shop shelf",
  client: "Client cage",
  mobile: "Van / field kit",
};

/**
 * What a shelf line IS.
 *
 * A part is bought by its number - the number is how the price book, the
 * purchase order and the shelf label all agree they mean the same thing, so a
 * part without one cannot be ordered and is not really a part.
 *
 * A tool is bought once and kept. Most have no number anybody would recognise
 * - a 4 mm hex key is a 4 mm hex key - so the NAME is what identifies it. Some
 * do: an OEM alignment tool has a part number and wants it, both to order
 * another and to be sure it is the right one. So the number is optional here
 * rather than absent, and a tool that has one is orderable exactly like a part.
 */
export const STOCK_ITEM_KINDS = ["part", "tool"] as const;
export type StockItemKind = (typeof STOCK_ITEM_KINDS)[number];

export const ITEM_KIND_LABEL: Record<string, string> = {
  part: "Part",
  tool: "Tool",
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
  room: { orgId: number | null; tenantOrgId?: number | null },
  share: { access: string } | undefined,
): { see: boolean; issue: boolean; manage: boolean } {
  // The house of the room's own workspace. Another operator's staff get nothing
  // from being staff: a stockroom is one company's shelf.
  if (houseOfRecord(viewer, room.tenantOrgId)) return { see: true, issue: true, manage: true };
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

export type StockIdentity = { partNumber: string; name: string };

/**
 * What makes two shelf lines the SAME line: the number when there is one, the
 * name when there is not.
 *
 * One key rather than two columns, because a shelf counted under two spellings
 * of one thing is two lines that never add up - the same failure the catalog's
 * alias table exists to prevent, and it does not stop mattering because the
 * thing is a wrench. The number wins whenever there is one, so a tool that
 * later earns a part number keeps counting on the line it already had.
 *
 * Case-folded and trimmed, and NOT normalizePn'd - deliberately. This is the
 * database's key, mirroring the expression the unique index in schema-sync.sql
 * is built on, so what this says is a duplicate and what the database refuses
 * are the same set. normalizePn is the looser matcher used to find a line
 * against the PRICE BOOK (see findLine), where a number typed with a stray
 * space should still price; using it here would have this function claim two
 * rows are one line while the index happily stored both.
 */
export function stockKey(line: StockIdentity): string {
  return (line.partNumber.trim() || line.name.trim()).toLowerCase();
}

/** Find the line something would land on, by whichever identity it carries. */
export function findStockLine<T extends StockIdentity>(lines: T[], want: StockIdentity): T | undefined {
  const key = stockKey(want);
  if (!key) return undefined;
  return lines.find((l) => stockKey(l) === key);
}

/**
 * What to call a line in a sentence - an audit line, a toast, a ledger row.
 *
 * "PN 228-35145-91" for a part, because the number is what somebody standing
 * at the shelf reads. The name for a tool, because "PN " followed by nothing
 * is how a ledger stops being readable.
 */
export function stockLabel(line: StockIdentity): string {
  return line.partNumber.trim() ? `PN ${line.partNumber.trim()}` : line.name.trim() || "an unnamed line";
}

/**
 * May this land on a shelf?
 *
 * The one rule that differs by kind, said once so the grid, the server and the
 * transfer cannot disagree about it. A part is refused without a number - it
 * could not be ordered or priced, and a nameless, numberless row is a count of
 * nothing. A tool is refused without a name, and its number stays optional.
 */
export function checkStockItem(row: { kind?: string; partNumber: string; name: string }): string | null {
  const kind = row.kind === "tool" ? "tool" : "part";
  if (kind === "tool") {
    return row.name.trim() ? null : "A tool needs a name - the number is optional";
  }
  return row.partNumber.trim() ? null : "A part needs a part number";
}
