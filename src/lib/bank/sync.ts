// The bank feed: what the bank says happened, pulled into bank_transactions.
//
// Provider: Plaid Transactions, through its sync endpoint - a cursor, a page
// of added/modified/removed, repeated until has_more is false. The cursor is
// kept per workspace in bank_connections. Nothing here posts to the ledger;
// the feed is read-only, and the Cash page is where a line gets a home.
//
// Runs on the hourly cron beside sheet-sync, behind the same bearer secret,
// and by hand from the Cash page. A workspace with no connection is quiet.
// Configuration is three environment variables; with them absent the link
// flow says so and the feed stays empty, which is a supported state.

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { bankConnections, bankTransactions } from "@/db/schema";

export type PlaidTxn = {
  transaction_id: string;
  date: string;
  name?: string;
  merchant_name?: string | null;
  /** Plaid: positive is money OUT of the account. We store money in as positive. */
  amount: number;
  pending?: boolean;
};

export type SyncPage = { added: PlaidTxn[]; modified: PlaidTxn[]; removed: { transaction_id: string }[]; next_cursor: string; has_more: boolean };

const PLAID_ENV = () => (process.env.PLAID_ENV ?? "sandbox").trim();
const PLAID_BASE = () => `https://${PLAID_ENV()}.plaid.com`;

export const plaidConfigured = (): boolean =>
  !!(process.env.PLAID_CLIENT_ID ?? "").trim() && !!(process.env.PLAID_SECRET ?? "").trim();

async function plaid(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!plaidConfigured()) throw new Error("The bank feed is not configured on this instance.");
  const res = await fetch(`${PLAID_BASE()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: process.env.PLAID_CLIENT_ID!.trim(), secret: process.env.PLAID_SECRET!.trim(), ...body }),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(String((json as { error_message?: string }).error_message ?? "The bank feed refused the request"));
  return json;
}

/** A Link token for the owner's browser to open Plaid Link with. */
export async function linkToken(tenantOrgId: number, userEmail: string): Promise<string> {
  const json = await plaid("/link/token/create", {
    user: { client_user_id: `org-${tenantOrgId}-${userEmail}` },
    client_name: "Ridgeline",
    products: ["transactions"],
    country_codes: ["US"],
    language: "en",
  });
  return String(json.link_token);
}

/** Exchange Link's public token for the access token this workspace keeps. */
export async function exchangePublicToken(publicToken: string): Promise<{ accessToken: string; itemId: string }> {
  const json = await plaid("/item/public_token/exchange", { public_token: publicToken });
  return { accessToken: String(json.access_token), itemId: String(json.item_id) };
}

/** One page of the sync, from a cursor. */
export async function syncPage(accessToken: string, cursor: string): Promise<SyncPage> {
  const json = await plaid("/transactions/sync", { access_token: accessToken, cursor: cursor || undefined, count: 250 });
  return json as unknown as SyncPage;
}

export type SyncResult = { added: number; modified: number; removed: number; pages: number };

/**
 * Pull everything new for one connection into bank_transactions. Pending
 * transactions are skipped - the bank has not settled them, and a line that
 * may change amount is not a fact to reconcile against yet.
 */
export async function syncConnection(
  conn: { id: number; tenantOrgId: number | null; provider: string; accessToken: string; cursor: string },
  fetchPage: (accessToken: string, cursor: string) => Promise<SyncPage> = syncPage,
): Promise<SyncResult> {
  const out: SyncResult = { added: 0, modified: 0, removed: 0, pages: 0 };
  let cursor = conn.cursor;
  for (let i = 0; i < 40; i++) {
    const page = await fetchPage(conn.accessToken, cursor);
    out.pages++;
    for (const t of [...page.added, ...page.modified]) {
      if (t.pending) continue;
      const row = {
        provider: conn.provider, providerTxnId: t.transaction_id,
        on: t.date, description: (t.merchant_name || t.name || "").slice(0, 200),
        amountCents: -Math.round(t.amount * 100),
      };
      const [existing] = await db.select({ id: bankTransactions.id }).from(bankTransactions)
        .where(and(eq(bankTransactions.provider, conn.provider), eq(bankTransactions.providerTxnId, t.transaction_id)));
      if (existing) {
        await db.update(bankTransactions).set({ on: row.on, description: row.description, amountCents: row.amountCents })
          .where(eq(bankTransactions.id, existing.id));
        out.modified++;
      } else {
        await db.insert(bankTransactions).values({ ...row, tenantOrgId: conn.tenantOrgId });
        out.added++;
      }
    }
    // A removed line is one the bank withdrew - a duplicate it posted and
    // corrected. Its match, if any, goes back to unmatched; the row goes.
    for (const r of page.removed) {
      const gone = await db.delete(bankTransactions)
        .where(and(eq(bankTransactions.provider, conn.provider), eq(bankTransactions.providerTxnId, r.transaction_id)))
        .returning({ id: bankTransactions.id });
      out.removed += gone.length;
    }
    cursor = page.next_cursor;
    await db.update(bankConnections).set({ cursor, lastSyncAt: new Date(), lastError: "" }).where(eq(bankConnections.id, conn.id));
    if (!page.has_more) break;
  }
  return out;
}

/** Every workspace's feed, for the cron. */
export async function syncAllBanks(): Promise<{ connections: number; added: number; failed: { id: number; error: string }[] }> {
  const conns = await db.select().from(bankConnections);
  const out = { connections: conns.length, added: 0, failed: [] as { id: number; error: string }[] };
  for (const c of conns) {
    try {
      const r = await syncConnection(c);
      out.added += r.added;
    } catch (e) {
      out.failed.push({ id: c.id, error: (e as Error).message });
      await db.update(bankConnections).set({ lastError: (e as Error).message.slice(0, 300) }).where(eq(bankConnections.id, c.id));
    }
  }
  return out;
}
