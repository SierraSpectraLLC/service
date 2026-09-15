// The ledger, as one import. Every money figure on every screen is a SUM()
// over rows that came through post(); see the invariants in post.ts,
// reverse.ts and close.ts, and docs/design/LEDGER-VERIFY.md.
export * from "@/lib/ledger/accounts";
export { post, pair, checkLines, postingKey, closedThrough, setPostSink, LedgerError, type PostInput, type PostLine, type PostRef, type Posted, type Db } from "@/lib/ledger/post";
export { reverse, reversalOf, bankMatched, type ReverseInput } from "@/lib/ledger/reverse";
export { isClosed, closeProblem, closeBooksThrough } from "@/lib/ledger/close";
export {
  accountSums, sumAccount, balanceOf, balancesByRef, sumsByOrg, positions, periodFlow, entries, timelineFor,
  type AccountSum, type OrgSums, type LedgerFilter, type LedgerEntry, type LedgerLine, type Positions, type PeriodFlow,
} from "@/lib/ledger/sums";
