// Correcting the journal: the mirror entry.
//
// Nothing here edits or deletes. A reversal is a new entry whose lines are
// the original's with the sides swapped, dated TODAY - never the original's
// day, because that day may be closed and because "when was this corrected"
// is a fact worth keeping. The original stays, with the mirror pointing at it.
//
// The one thing that cannot be reversed from here is an entry matched to a
// bank transaction. The bank saw that money move; reversing our side alone
// would make the books disagree with the statement by exactly the amount
// somebody wanted to make disappear. It is corrected by a new entry when the
// refund or return shows up in the feed.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { bankTransactions, ledgerEntries, ledgerLines } from "@/db/schema";
import { LedgerError, post, type Db, type Posted } from "@/lib/ledger/post";
import { isRefType, type AccountKey } from "@/lib/ledger/accounts";

export type ReverseInput = {
  entryId: number;
  reason: string;
  postedBy: string;
  /** The shop day, from the caller: this module reads no clock. */
  today: string;
  tx?: Db;
};

/** Is this entry already undone? The mirror carries reverses_id, so ask for one. */
export async function reversalOf(entryId: number, tx: Db = db): Promise<number | null> {
  const [m] = await tx.select({ id: ledgerEntries.id }).from(ledgerEntries).where(eq(ledgerEntries.reversesId, entryId));
  return m?.id ?? null;
}

/** Is the entry pinned to a bank line? */
export async function bankMatched(entryId: number, tx: Db = db): Promise<boolean> {
  const [b] = await tx.select({ id: bankTransactions.id }).from(bankTransactions)
    .where(eq(bankTransactions.matchedEntryId, entryId));
  return !!b;
}

export async function reverse(input: ReverseInput): Promise<Posted> {
  const tx = input.tx ?? db;
  const [entry] = await tx.select().from(ledgerEntries).where(eq(ledgerEntries.id, input.entryId));
  if (!entry) throw new LedgerError("bad_line", "That entry does not exist.");
  if (entry.reversesId !== null) {
    throw new LedgerError("reversed", "That entry is itself a correction. Post the original again instead.");
  }
  if (await bankMatched(entry.id, tx)) {
    throw new LedgerError("bank_confirmed",
      "The bank saw this money move, so it cannot be reversed on our side alone. "
      + "Correct it with a new entry when the refund or return shows up in the feed.");
  }
  const already = await reversalOf(entry.id, tx);
  if (already !== null) return { id: already, created: false };

  const lines = await tx.select().from(ledgerLines).where(eq(ledgerLines.entryId, entry.id));
  const why = input.reason.trim();
  return post({
    on: input.today,
    memo: `Reversal of #${entry.id} - ${entry.memo}${why ? ` - ${why}` : ""}`,
    ref: {
      type: isRefType(entry.refType) ? entry.refType : "bank",
      id: entry.refId,
      orgId: entry.refOrgId,
      workOrderId: entry.refWorkOrderId,
    },
    lines: lines.map((l) => ({
      account: l.account as AccountKey,
      debitCents: l.creditCents,
      creditCents: l.debitCents,
    })),
    postedBy: input.postedBy,
    tenantOrgId: entry.tenantOrgId,
    kind: `reverse:${entry.id}`,
    reversesId: entry.id,
    tx,
  });
}
