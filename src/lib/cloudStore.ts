// One person's connection to their own file store: kept, refreshed, and handed
// out as an access token nobody above this file ever sees.
//
// Server-only. The two rules it exists to enforce:
//
//   1. A connection belongs to the individual who made it. Every read is keyed
//      by the signed-in email, never by organization, because this token can see
//      whatever that person can see in their own company - including things
//      their colleagues cannot.
//   2. Tokens live sealed (lib/secretBox) and come out only to be put in an
//      Authorization header.

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { cloudConnections } from "@/db/schema";
import { open, seal, vaultConfigured, VAULT_UNCONFIGURED } from "@/lib/secretBox";
import { graphConfig, NOT_CONFIGURED, refreshTokens, whoAmI, type TokenSet } from "@/lib/msgraph";

export const PROVIDER = "microsoft";

/** Refresh a little early: a token that expires mid-request is a failed click. */
const EARLY_MS = 120_000;

export type ConnectionView = {
  accountName: string;
  accountEmail: string;
  connectedAt: Date;
  lastUsedAt: Date | null;
  /** Set when Microsoft has refused this connection - it needs remaking, not retrying. */
  brokenReason: string;
};

/** What a page may know about a connection. Deliberately carries no token. */
export async function connectionView(email: string): Promise<ConnectionView | null> {
  const [row] = await db.select({
    accountName: cloudConnections.accountName,
    accountEmail: cloudConnections.accountEmail,
    connectedAt: cloudConnections.connectedAt,
    lastUsedAt: cloudConnections.lastUsedAt,
    brokenReason: cloudConnections.brokenReason,
    refreshToken: cloudConnections.refreshToken,
  }).from(cloudConnections)
    .where(and(eq(cloudConnections.email, email), eq(cloudConnections.provider, PROVIDER)))
    .catch(() => []);
  if (!row) return null;
  // A row this server cannot decrypt is worse than no row: it looks connected
  // and fails on use. Say so here, where the page can offer "connect again".
  const readable = open(row.refreshToken) !== null;
  return {
    accountName: row.accountName, accountEmail: row.accountEmail,
    connectedAt: row.connectedAt, lastUsedAt: row.lastUsedAt,
    brokenReason: readable ? row.brokenReason
      : "This server cannot read the stored connection. Connect again.",
  };
}

/** Write the connection down after a successful handshake. */
export async function saveConnection(
  email: string, tenantOrgId: number | null, tokens: TokenSet,
): Promise<{ error?: string }> {
  if (!vaultConfigured()) return { error: VAULT_UNCONFIGURED };
  const who = await whoAmI(tokens.accessToken);
  const row = {
    email, provider: PROVIDER,
    accountName: who.name, accountEmail: who.email,
    refreshToken: seal(tokens.refreshToken),
    accessToken: seal(tokens.accessToken),
    accessExpiresAt: new Date(tokens.expiresAt),
    scopes: tokens.scopes,
    connectedAt: new Date(),
    lastUsedAt: new Date(),
    brokenReason: "",
  };
  // The stamp is spelled out here rather than folded into `row` so that the
  // static guard in tests/tenantStamp.test.ts can see it - it reads the text of
  // the insert, and cannot follow a variable.
  await db.insert(cloudConnections).values({ ...row, tenantOrgId })
    .onConflictDoUpdate({
      target: [cloudConnections.email, cloudConnections.provider],
      set: { ...row, tenantOrgId },
    });
  return {};
}

export async function removeConnection(email: string): Promise<void> {
  await db.delete(cloudConnections)
    .where(and(eq(cloudConnections.email, email), eq(cloudConnections.provider, PROVIDER)));
}

/**
 * A usable access token for this person, refreshing if the cached one is spent.
 *
 * `error` is always something a person can act on. The one that matters is a
 * refused refresh: Microsoft says no when the password changed, consent was
 * withdrawn, or an admin revoked the session - none of which retrying fixes, so
 * the row is marked broken and the UI stops pretending.
 */
export async function accessTokenFor(email: string): Promise<{ token?: string; error?: string }> {
  const cfg = graphConfig();
  if (!cfg) return { error: NOT_CONFIGURED };
  if (!vaultConfigured()) return { error: VAULT_UNCONFIGURED };

  const [row] = await db.select().from(cloudConnections)
    .where(and(eq(cloudConnections.email, email), eq(cloudConnections.provider, PROVIDER)))
    .catch(() => []);
  if (!row) return { error: "No OneDrive account is connected yet." };

  const cached = open(row.accessToken);
  if (cached && row.accessExpiresAt && row.accessExpiresAt.getTime() - EARLY_MS > Date.now()) {
    return { token: cached };
  }

  const refresh = open(row.refreshToken);
  if (!refresh) {
    await markBroken(email, "This server cannot read the stored connection. Connect again.");
    return { error: "This server cannot read the stored connection. Connect again." };
  }

  const next = await refreshTokens(cfg, refresh);
  if ("error" in next) {
    await markBroken(email, next.error);
    return { error: `${next.error} Connect again to fix it.` };
  }
  await db.update(cloudConnections).set({
    accessToken: seal(next.accessToken),
    accessExpiresAt: new Date(next.expiresAt),
    // Microsoft re-issues a refresh token only sometimes; keeping the old one
    // when none comes back is the difference between a connection that lasts and
    // one that dies on its second day.
    ...(next.refreshToken ? { refreshToken: seal(next.refreshToken) } : {}),
    lastUsedAt: new Date(),
    brokenReason: "",
  }).where(and(eq(cloudConnections.email, email), eq(cloudConnections.provider, PROVIDER)));
  return { token: next.accessToken };
}

async function markBroken(email: string, why: string): Promise<void> {
  await db.update(cloudConnections)
    .set({ brokenReason: why, accessToken: "", accessExpiresAt: null })
    .where(and(eq(cloudConnections.email, email), eq(cloudConnections.provider, PROVIDER)))
    .catch(() => {});
}

/**
 * Run a Graph call, refreshing once if the token turns out to be dead early.
 *
 * Graph answers 401 for a token that expired between the check above and the
 * call - a race with a clock, and one retry is the whole fix. Everything else is
 * passed straight back.
 */
export async function withGraph<T extends { error?: string }>(
  email: string, call: (token: string) => Promise<T>,
): Promise<T> {
  // Every call here answers in the same {value?, error?} shape, so a failure is
  // one of those rather than a second return type callers have to narrow.
  const fail = (error: string) => ({ error } as T);

  const first = await accessTokenFor(email);
  if (!first.token) return fail(first.error ?? "No OneDrive account is connected yet.");
  const out = await call(first.token);
  if (out.error !== "expired") return out;

  await db.update(cloudConnections).set({ accessToken: "", accessExpiresAt: null })
    .where(and(eq(cloudConnections.email, email), eq(cloudConnections.provider, PROVIDER)))
    .catch(() => {});
  const second = await accessTokenFor(email);
  if (!second.token) return fail(second.error ?? "That connection needs making again.");
  const retry = await call(second.token);
  return retry.error === "expired"
    ? fail("Microsoft would not accept the connection. Connect again.")
    : retry;
}
