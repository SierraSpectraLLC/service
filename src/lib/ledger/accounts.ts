// The chart of accounts. A constant, not a table.
//
// Fixed vocabulary, one key per thing the shop can owe, own, earn or spend.
// Users do not add accounts. If a posting does not fit one of these, the code
// that wants to post it is wrong, not the chart - a chart people can extend
// is a chart nobody can sum, because "Misc" ends up holding half the money.
//
// Pure: no database, no React. lib/ledger/sums and every screen read it.

/** Which side a balance grows on. Bank grows on debits; revenue on credits. */
export type Side = "dr" | "cr";

/** How the report groups it. Positions are stocks; revenue and cost are flows. */
export type AccountGroup = "asset" | "liability" | "revenue" | "cost" | "equity";

export type Account = {
  key: AccountKey;
  name: string;
  side: Side;
  group: AccountGroup;
};

export const ACCOUNT_KEYS = [
  "bank", "stripe", "receivable", "payable", "deposits_held", "sales_tax_owed",
  "revenue_labor", "revenue_parts", "revenue_travel", "revenue_contract", "revenue_fees",
  "cost_parts", "cost_field_expenses", "cost_processing", "overhead", "payroll",
  "opening_balance",
] as const;
export type AccountKey = (typeof ACCOUNT_KEYS)[number];

export const ACCOUNTS: Record<AccountKey, Account> = {
  bank:               { key: "bank",               name: "Bank",             side: "dr", group: "asset" },
  stripe:             { key: "stripe",             name: "Stripe balance",   side: "dr", group: "asset" },
  receivable:         { key: "receivable",         name: "Receivable",       side: "dr", group: "asset" },
  payable:            { key: "payable",            name: "Payable",          side: "cr", group: "liability" },
  deposits_held:      { key: "deposits_held",      name: "Deposits held",    side: "cr", group: "liability" },
  sales_tax_owed:     { key: "sales_tax_owed",     name: "Sales tax owed",   side: "cr", group: "liability" },
  revenue_labor:      { key: "revenue_labor",      name: "Labor revenue",    side: "cr", group: "revenue" },
  revenue_parts:      { key: "revenue_parts",      name: "Parts revenue",    side: "cr", group: "revenue" },
  revenue_travel:     { key: "revenue_travel",     name: "Travel revenue",   side: "cr", group: "revenue" },
  revenue_contract:   { key: "revenue_contract",   name: "Contract revenue", side: "cr", group: "revenue" },
  revenue_fees:       { key: "revenue_fees",       name: "Fees",             side: "cr", group: "revenue" },
  cost_parts:         { key: "cost_parts",         name: "Parts cost",       side: "dr", group: "cost" },
  cost_field_expenses:{ key: "cost_field_expenses",name: "Field expenses",   side: "dr", group: "cost" },
  cost_processing:    { key: "cost_processing",    name: "Processing fees",  side: "dr", group: "cost" },
  overhead:           { key: "overhead",           name: "Overhead",         side: "dr", group: "cost" },
  payroll:            { key: "payroll",            name: "Payroll",          side: "dr", group: "cost" },
  opening_balance:    { key: "opening_balance",    name: "Opening balance",  side: "cr", group: "equity" },
};

export const isAccountKey = (v: unknown): v is AccountKey =>
  typeof v === "string" && (ACCOUNT_KEYS as readonly string[]).includes(v);

export const accountName = (k: string): string => isAccountKey(k) ? ACCOUNTS[k].name : k;

/** The accounts of one group, in chart order. */
export const accountsIn = (group: AccountGroup): AccountKey[] =>
  ACCOUNT_KEYS.filter((k) => ACCOUNTS[k].group === group);

export const REVENUE_ACCOUNTS = accountsIn("revenue");
export const COST_ACCOUNTS = accountsIn("cost");
/** What "cash" means on every screen: the bank plus what Stripe is holding. */
export const CASH_ACCOUNTS: readonly AccountKey[] = ["bank", "stripe"] as const;

/**
 * The document kinds an entry can point at. `referral` is the fee itself;
 * a referral fee that is invoiced posts as `invoice` like any other bill.
 */
export const REF_TYPES = [
  "opening", "invoice", "job", "po", "bill", "report", "payroll", "bank", "payout", "tax", "referral",
] as const;
export type RefType = (typeof REF_TYPES)[number];

export const isRefType = (v: unknown): v is RefType =>
  typeof v === "string" && (REF_TYPES as readonly string[]).includes(v);

export const REF_LABEL: Record<RefType, string> = {
  opening: "Opening balance", invoice: "Invoice", job: "Job", po: "Purchase order", bill: "Bill",
  report: "Expense report", payroll: "Payroll", bank: "Bank line", payout: "Stripe payout",
  tax: "Sales tax", referral: "Referral fee",
};

/** The revenue account an invoice line kind posts to. */
export function revenueAccountFor(kind: string): AccountKey {
  switch (kind) {
    case "labor": return "revenue_labor";
    case "part": return "revenue_parts";
    case "travel": return "revenue_travel";
    case "retainer": return "revenue_contract";
    // Fees, credit memos and pass-through expenses: not labour, not parts. An
    // expense re-billed to the client is revenue that offsets a field cost,
    // which is what the fees account already holds.
    default: return "revenue_fees";
  }
}

/**
 * A balance from raw sums, on the account's own side. A debit-side account
 * with more credits than debits reads negative - which is a fact, not an
 * error, and the screen that shows it says so.
 */
export function balanceFrom(account: AccountKey, debitCents: number, creditCents: number): number {
  return ACCOUNTS[account].side === "dr" ? debitCents - creditCents : creditCents - debitCents;
}
