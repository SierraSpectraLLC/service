// Posting to the journal: the one door.
//
// Every entry the ledger holds came through post(). It enforces two of the
// four invariants - balanced, and not into a closed month - and the third by
// what it does not offer: there is no update and no delete here, or anywhere.
// The fourth (a bank-confirmed entry stays) is lib/ledger/reverse's.
//
// A Drizzle handle can be passed in for callers that have one; the default is
// the app's own. The Neon HTTP driver this app runs on has no transactions,
// which is why every posting carries a posting key: a caller that fails
// halfway and retries cannot post the same money twice, because the second
// attempt finds the first by its key and returns it.

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { appSettings, ledgerEntries, ledgerLines } from "@/db/schema";
import { forTenant } from "@/lib/tenancy";
import { isAccountKey, isRefType, type AccountKey, type RefType } from "@/lib/ledger/accounts";
import { isClosed } from "@/lib/ledger/close";

/** Any Drizzle handle with the app's query API - the real db or a test one. */
export type Db = typeof db;

export type PostLine = {
  account: AccountKey;
  debitCents?: number;
  creditCents?: number;
};

export type PostRef = {
  type: RefType;
  /** The document's own id or number, as text. */
  id: string | number;
  orgId?: number | null;
  workOrderId?: number | null;
};

export type PostInput = {
  /** The shop day the money moved, YYYY-MM-DD. */
  on: string;
  memo: string;
  ref: PostRef;
  lines: PostLine[];
  postedBy: string;
  tenantOrgId: number | null;
  /**
   * The natural key of this posting within its document - "send", "payment:12",
   * "fee:3". With the ref it forms the posting key that makes the write
   * idempotent. Omit only for a posting with no natural key.
   */
  kind?: string;
  /** Set on a reversal, by lib/ledger/reverse. */
  reversesId?: number | null;
  /** Lets a caller keep posting into a closed month: the backfill, and nobody else. */
  ignoreClose?: boolean;
  tx?: Db;
};

export type Posted = { id: number; created: boolean };

/** Why a posting was refused. `code` is what a screen switches on. */
export class LedgerError extends Error {
  constructor(public readonly code: "unbalanced" | "closed" | "bad_line" | "bad_date" | "bank_confirmed" | "reversed", message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `ref_type:ref_id:kind`, or blank when the posting has no natural key. */
export function postingKey(ref: PostRef, kind: string | undefined): string {
  return kind ? `${ref.type}:${ref.id}:${kind}` : "";
}

/**
 * Check the shape of an entry without writing it. Pure, and exported so a
 * form can refuse before it posts and a test can argue with the rule.
 */
export function checkLines(lines: PostLine[]): { debits: number; credits: number } {
  if (lines.length < 2) throw new LedgerError("bad_line", "An entry needs at least two lines.");
  let debits = 0, credits = 0;
  for (const l of lines) {
    if (!isAccountKey(l.account)) throw new LedgerError("bad_line", `"${l.account}" is not an account in the chart.`);
    const dr = l.debitCents ?? 0, cr = l.creditCents ?? 0;
    if (!Number.isInteger(dr) || !Number.isInteger(cr) || dr < 0 || cr < 0) {
      throw new LedgerError("bad_line", "Money is whole cents, never negative: post the other side instead.");
    }
    if ((dr > 0) === (cr > 0)) {
      throw new LedgerError("bad_line", "Each line is a debit or a credit, above zero, and not both.");
    }
    debits += dr; credits += cr;
  }
  if (debits !== credits) {
    throw new LedgerError("unbalanced", `Debits ${debits} do not equal credits ${credits}.`);
  }
  return { debits, credits };
}

/** The last closed month, "YYYY-MM" or blank. */
export async function closedThrough(tx: Db = db): Promise<string> {
  const [row] = await tx.select({ ym: appSettings.booksClosedThrough }).from(appSettings)
    .where(eq(appSettings.id, 1));
  return row?.ym ?? "";
}

/**
 * Write one entry. Returns its id, and whether this call created it: a
 * posting whose key already exists is returned rather than posted again.
 */
export async function post(input: PostInput): Promise<Posted> {
  const tx = input.tx ?? db;
  if (!ISO_DAY.test(input.on)) throw new LedgerError("bad_date", `"${input.on}" is not a day.`);
  if (!isRefType(input.ref.type)) throw new LedgerError("bad_line", `"${input.ref.type}" is not a document kind the ledger knows.`);
  checkLines(input.lines);

  const key = postingKey(input.ref, input.kind);
  if (key) {
    const [existing] = await tx.select({ id: ledgerEntries.id }).from(ledgerEntries)
      .where(and(forTenant(ledgerEntries.tenantOrgId, input.tenantOrgId), eq(ledgerEntries.postingKey, key)));
    if (existing) return { id: existing.id, created: false };
  }

  if (!input.ignoreClose && isClosed(input.on, await closedThrough(tx))) {
    throw new LedgerError("closed",
      `${input.on} is in a closed month. Post it today instead - the record keeps both.`);
  }

  const [entry] = await tx.insert(ledgerEntries).values({
    tenantOrgId: input.tenantOrgId,
    postedOn: input.on,
    memo: input.memo.trim().slice(0, 400),
    refType: input.ref.type,
    refId: String(input.ref.id),
    refOrgId: input.ref.orgId ?? null,
    refWorkOrderId: input.ref.workOrderId ?? null,
    reversesId: input.reversesId ?? null,
    postingKey: key,
    postedBy: input.postedBy,
  }).returning({ id: ledgerEntries.id });

  await tx.insert(ledgerLines).values(input.lines.map((l) => ({
    entryId: entry.id,
    account: l.account,
    debitCents: l.debitCents ?? 0,
    creditCents: l.creditCents ?? 0,
  })));

  return { id: entry.id, created: true };
}

/** Sugar for the commonest shape: one account up, one down, one amount. */
export function pair(debit: AccountKey, credit: AccountKey, cents: number): PostLine[] {
  return [{ account: debit, debitCents: cents }, { account: credit, creditCents: cents }];
}
