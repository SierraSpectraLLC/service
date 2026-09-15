// Reading the journal. One query shape, filtered six ways.
//
// Every figure a money screen shows is one of these sums. There is no other
// arithmetic: a page that wants a number asks for the rows that make it and
// adds them up here, so the rail badge, the lane total and the ledger page
// that opens when you click either are the same SUM() over the same WHERE.
//
// forTenant() on every read. A null tenant is platform staff, who see the
// instance; everybody else sees their workspace's rows and nothing else.

import { cache } from "react";
import { and, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { bankTransactions, ledgerEntries, ledgerLines } from "@/db/schema";
import { forTenant } from "@/lib/tenancy";
import {
  ACCOUNTS, balanceFrom, COST_ACCOUNTS, isAccountKey, isRefType, REVENUE_ACCOUNTS,
  type AccountKey, type RefType,
} from "@/lib/ledger/accounts";

export type LedgerFilter = {
  tenant: number | null;
  /** Inclusive shop days. */
  from?: string;
  to?: string;
  account?: AccountKey;
  /** Only lines on this side of the account - "out" of the bank is its credits. */
  side?: "dr" | "cr";
  refType?: RefType;
  refId?: string;
  refOrgId?: number;
  refWorkOrderId?: number;
  /** Memo or document number contains this, case-insensitively. */
  q?: string;
  /** Leave out entries that were reversed, and the reversals themselves. */
  liveOnly?: boolean;
};

/** The WHERE for a filter, over ledger_entries joined to ledger_lines. */
function whereFor(f: LedgerFilter): SQL | undefined {
  const parts: (SQL | undefined)[] = [
    forTenant(ledgerEntries.tenantOrgId, f.tenant),
    f.from ? gte(ledgerEntries.postedOn, f.from) : undefined,
    f.to ? lte(ledgerEntries.postedOn, f.to) : undefined,
    f.refType ? eq(ledgerEntries.refType, f.refType) : undefined,
    f.refId !== undefined ? eq(ledgerEntries.refId, f.refId) : undefined,
    f.refOrgId !== undefined ? eq(ledgerEntries.refOrgId, f.refOrgId) : undefined,
    f.refWorkOrderId !== undefined ? eq(ledgerEntries.refWorkOrderId, f.refWorkOrderId) : undefined,
    f.q ? sql`(lower(${ledgerEntries.memo}) like ${`%${f.q.toLowerCase()}%`} or lower(${ledgerEntries.refId}) like ${`%${f.q.toLowerCase()}%`})` : undefined,
    f.liveOnly
      ? sql`${ledgerEntries.reversesId} is null and not exists (select 1 from ${ledgerEntries} r where r.reverses_id = ${ledgerEntries.id})`
      : undefined,
  ];
  return and(...parts);
}

/** Line-level narrowing: which account, and which side of it. */
function lineWhere(f: LedgerFilter): SQL | undefined {
  return and(
    f.account ? eq(ledgerLines.account, f.account) : undefined,
    f.side === "dr" ? sql`${ledgerLines.debitCents} > 0` : f.side === "cr" ? sql`${ledgerLines.creditCents} > 0` : undefined,
  );
}

export type AccountSum = { account: AccountKey; debitCents: number; creditCents: number; balanceCents: number };

/**
 * Debits, credits and the balance per account, over whatever the filter
 * keeps. THE query: everything else in this file is a call to it.
 */
export async function accountSums(f: LedgerFilter): Promise<AccountSum[]> {
  const rows = await db.select({
    account: ledgerLines.account,
    debit: sql<number>`coalesce(sum(${ledgerLines.debitCents}), 0)`,
    credit: sql<number>`coalesce(sum(${ledgerLines.creditCents}), 0)`,
  }).from(ledgerLines)
    .innerJoin(ledgerEntries, eq(ledgerLines.entryId, ledgerEntries.id))
    .where(and(whereFor(f), lineWhere(f)))
    .groupBy(ledgerLines.account);
  return rows.filter((r) => isAccountKey(r.account)).map((r) => {
    const account = r.account as AccountKey;
    const debitCents = Number(r.debit), creditCents = Number(r.credit);
    return { account, debitCents, creditCents, balanceCents: balanceFrom(account, debitCents, creditCents) };
  });
}

/** One account's balance under the filter. Zero when nothing matches. */
export async function sumAccount(account: AccountKey, f: Omit<LedgerFilter, "account">): Promise<number> {
  const [row] = await accountSums({ ...f, account });
  if (!row) return 0;
  // A side filter asks for one flow rather than a balance: "what left the
  // bank" is the credits, as a positive number.
  if (f.side === "cr") return row.creditCents;
  if (f.side === "dr") return row.debitCents;
  return row.balanceCents;
}

/** What one invoice is still owed, from the receivable rows that carry its id. */
export async function balanceOf(invoiceId: number, tenant: number | null): Promise<number> {
  return sumAccount("receivable", { tenant, refType: "invoice", refId: String(invoiceId) });
}

export type Positions = {
  bank: number; stripe: number; receivable: number; payable: number;
  depositsHeld: number; salesTaxOwed: number;
};

/**
 * The stocks: what is in the bank and in Stripe, what is owed each way, what
 * is held. One query, cached per request, because the rail and the page it
 * sits beside both ask.
 */
export const positions = cache(async (tenant: number | null): Promise<Positions> => {
  const sums = await accountSums({ tenant });
  const of = (k: AccountKey) => sums.find((s) => s.account === k)?.balanceCents ?? 0;
  return {
    bank: of("bank"), stripe: of("stripe"), receivable: of("receivable"), payable: of("payable"),
    depositsHeld: of("deposits_held"), salesTaxOwed: of("sales_tax_owed"),
  };
});

export type PeriodFlow = {
  revenue: Record<AccountKey, number>;
  cost: Record<AccountKey, number>;
  revenueCents: number;
  costCents: number;
  /** Money that reached the bank or Stripe in the window, and money that left. */
  cashInCents: number;
  cashOutCents: number;
};

/** The flows: revenue and cost by account inside a window, and what cash did. */
export const periodFlow = cache(async (tenant: number | null, from: string, to: string): Promise<PeriodFlow> => {
  const sums = await accountSums({ tenant, from, to });
  const revenue = {} as Record<AccountKey, number>, cost = {} as Record<AccountKey, number>;
  let revenueCents = 0, costCents = 0, cashIn = 0, cashOut = 0;
  for (const k of REVENUE_ACCOUNTS) { revenue[k] = 0; }
  for (const k of COST_ACCOUNTS) { cost[k] = 0; }
  for (const s of sums) {
    if (ACCOUNTS[s.account].group === "revenue") { revenue[s.account] = s.balanceCents; revenueCents += s.balanceCents; }
    if (ACCOUNTS[s.account].group === "cost") { cost[s.account] = s.balanceCents; costCents += s.balanceCents; }
    if (s.account === "bank" || s.account === "stripe") { cashIn += s.debitCents; cashOut += s.creditCents; }
  }
  return { revenue, cost, revenueCents, costCents, cashInCents: cashIn, cashOutCents: cashOut };
});

export type LedgerLine = { id: number; account: AccountKey; debitCents: number; creditCents: number };
export type LedgerEntry = {
  id: number;
  postedOn: string;
  memo: string;
  refType: RefType | "";
  refId: string;
  refOrgId: number | null;
  refWorkOrderId: number | null;
  reversesId: number | null;
  /** The id of the entry that reversed this one, when one has. */
  reversedBy: number | null;
  /** The bank line this entry is matched to, when it is. */
  bankTxnId: number | null;
  postedBy: string;
  lines: LedgerLine[];
  /** The entry's size: its total debits, which equal its total credits. */
  totalCents: number;
};

/**
 * The rows themselves, newest first, for the ledger page and a document's
 * money timeline. Entries whose lines match the account filter come back
 * whole - a filter on Bank shows both sides of the payment, because half an
 * entry is not a thing.
 */
export async function entries(f: LedgerFilter, limit = 500): Promise<LedgerEntry[]> {
  const ids = await db.selectDistinct({ id: ledgerEntries.id, on: ledgerEntries.postedOn }).from(ledgerEntries)
    .innerJoin(ledgerLines, eq(ledgerLines.entryId, ledgerEntries.id))
    .where(and(whereFor(f), lineWhere(f)))
    .orderBy(desc(ledgerEntries.postedOn), desc(ledgerEntries.id))
    .limit(limit);
  if (!ids.length) return [];
  const idList = ids.map((r) => r.id);
  const [heads, lines, mirrors, matched] = await Promise.all([
    db.select().from(ledgerEntries).where(inArray(ledgerEntries.id, idList)),
    db.select().from(ledgerLines).where(inArray(ledgerLines.entryId, idList)).orderBy(ledgerLines.id),
    db.select({ id: ledgerEntries.id, of: ledgerEntries.reversesId }).from(ledgerEntries)
      .where(inArray(ledgerEntries.reversesId, idList)),
    db.select({ id: bankTransactions.id, entry: bankTransactions.matchedEntryId }).from(bankTransactions)
      .where(inArray(bankTransactions.matchedEntryId, idList)),
  ]);
  const byEntry = new Map<number, LedgerLine[]>();
  for (const l of lines) {
    const list = byEntry.get(l.entryId) ?? [];
    list.push({ id: l.id, account: l.account as AccountKey, debitCents: l.debitCents, creditCents: l.creditCents });
    byEntry.set(l.entryId, list);
  }
  const reversedBy = new Map(mirrors.map((m) => [m.of as number, m.id]));
  const bankOf = new Map(matched.map((m) => [m.entry as number, m.id]));
  const order = new Map(idList.map((id, i) => [id, i]));
  return heads
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    .map((e) => {
      const ls = byEntry.get(e.id) ?? [];
      return {
        id: e.id, postedOn: e.postedOn, memo: e.memo,
        refType: isRefType(e.refType) ? e.refType : "", refId: e.refId,
        refOrgId: e.refOrgId, refWorkOrderId: e.refWorkOrderId, reversesId: e.reversesId,
        reversedBy: reversedBy.get(e.id) ?? null,
        bankTxnId: bankOf.get(e.id) ?? null,
        postedBy: e.postedBy, lines: ls,
        totalCents: ls.reduce((n, l) => n + l.debitCents, 0),
      };
    });
}

/** Every entry that names one document, oldest first - a drawer's money timeline. */
export async function timelineFor(tenant: number | null, refType: RefType, refId: string | number): Promise<LedgerEntry[]> {
  return (await entries({ tenant, refType, refId: String(refId) })).reverse();
}
