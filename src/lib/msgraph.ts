// The Microsoft boundary: everything that knows Graph's wire format lives here.
//
// One API covers OneDrive, OneDrive for Business and every SharePoint document
// library, which is why "can the studio reach our OneDrive" and "can it reach
// the client's SharePoint site" are the same feature rather than two.
//
// Shaped like lib/remote: a config that can be absent, a plain-English message
// when it is, and every call returning a value the caller can render rather than
// throwing into a page. Nothing above this file should ever mention Graph, an
// access token, or a driveItem.
//
// Delegated, never application, permissions. The app can see exactly what the
// signed-in person can see and nothing more - so connecting cannot quietly grant
// this portal read access to an entire tenant's documents.

import { createHash, randomBytes } from "node:crypto";
import { browseListing, searchListing, toCloudItem, type CloudItem } from "@/lib/cloudItems";
import { safeFileName } from "@/lib/cloudUpload";

export const NOT_CONFIGURED =
  "OneDrive is not set up on this instance yet. An owner adds the Microsoft app registration in the environment.";

/** Delegated scopes. `offline_access` is what makes the connection outlive the browser tab. */
export const SCOPES = ["offline_access", "openid", "profile", "User.Read", "Files.ReadWrite.All", "Sites.Read.All"];

/** Graph calls get a ceiling: a slow tenant must not hang a page render. */
const GRAPH_TIMEOUT_MS = 12_000;

export type GraphConfig = { clientId: string; clientSecret: string; tenant: string; redirectUri: string };

/**
 * `MS_TENANT` is `common` for "whichever tenant the person signs in to", or a
 * specific tenant id to lock this to one company. Defaulting to `common` is what
 * lets a client's own OneDrive be reachable at all - with a fixed tenant, only
 * Sierra's own accounts could ever connect.
 */
export function graphConfig(): GraphConfig | null {
  const clientId = process.env.MS_CLIENT_ID ?? "";
  const clientSecret = process.env.MS_CLIENT_SECRET ?? "";
  const base = (process.env.APP_URL || process.env.AUTH_URL || "").replace(/\/+$/, "");
  if (!clientId || !clientSecret || !base) return null;
  return {
    clientId, clientSecret,
    tenant: process.env.MS_TENANT || "common",
    redirectUri: `${base}/api/cloud/callback`,
  };
}

export const graphConfigured = () => graphConfig() !== null;

// ---------------------------------------------------------------------------
// The handshake
// ---------------------------------------------------------------------------

/** PKCE: a secret this server keeps, and the hash of it that travels. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

/**
 * Where to send somebody to approve this.
 *
 * PKCE as well as the client secret, even though a confidential client does not
 * strictly need it: it binds the code to the request that started it, so a code
 * intercepted from the redirect is worthless on its own.
 */
export function authorizeUrl(cfg: GraphConfig, state: string, challenge: string): string {
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: "code",
    redirect_uri: cfg.redirectUri,
    response_mode: "query",
    scope: SCOPES.join(" "),
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    // Ask every time. A silent re-connect that quietly picks whichever account
    // the browser last used is how somebody connects the wrong OneDrive.
    prompt: "select_account",
  });
  return `https://login.microsoftonline.com/${cfg.tenant}/oauth2/v2.0/authorize?${q}`;
}

export type TokenSet = {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token stops being accepted. */
  expiresAt: number;
  scopes: string;
};

/** Graph's token error shape, which is the only part of a failure worth showing. */
function tokenError(body: { error?: string; error_description?: string }): string {
  const desc = (body.error_description ?? "").split("\n")[0].trim();
  return desc || body.error || "Microsoft refused the connection.";
}

async function tokenCall(cfg: GraphConfig, form: Record<string, string>): Promise<TokenSet | { error: string }> {
  const stop = AbortSignal.timeout(GRAPH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://login.microsoftonline.com/${cfg.tenant}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...form }),
      signal: stop,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { error: tokenError(body) };
    if (typeof body.access_token !== "string") return { error: "Microsoft returned no access token." };
    return {
      accessToken: body.access_token,
      // A refresh token is only re-issued sometimes; keeping the old one when
      // none comes back is the difference between a connection that lasts and
      // one that dies on its second day.
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : "",
      expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
      scopes: typeof body.scope === "string" ? body.scope : "",
    };
  } catch (e) {
    return { error: `Could not reach Microsoft: ${(e as Error).message}` };
  }
}

export const exchangeCode = (cfg: GraphConfig, code: string, verifier: string) =>
  tokenCall(cfg, { grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri, code_verifier: verifier });

export const refreshTokens = (cfg: GraphConfig, refreshToken: string) =>
  tokenCall(cfg, { grant_type: "refresh_token", refresh_token: refreshToken, scope: SCOPES.join(" ") });

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const GRAPH = "https://graph.microsoft.com/v1.0";

async function get(accessToken: string, path: string): Promise<{ body?: Record<string, unknown>; error?: string }> {
  try {
    const res = await fetch(`${GRAPH}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    });
    if (res.status === 401) return { error: "expired" };
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: body?.error?.message || `Microsoft answered ${res.status}.` };
    }
    return { body: await res.json() };
  } catch (e) {
    return { error: `Could not reach Microsoft: ${(e as Error).message}` };
  }
}

/** Who this connection belongs to, for a label somebody can recognize. */
export async function whoAmI(accessToken: string): Promise<{ name: string; email: string }> {
  const { body } = await get(accessToken, "/me");
  return {
    name: String(body?.displayName ?? ""),
    email: String(body?.mail ?? body?.userPrincipalName ?? ""),
  };
}

const itemPath = (driveId: string, itemId: string) =>
  driveId ? `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(itemId)}`
    : `/me/drive/items/${encodeURIComponent(itemId)}`;

/** One folder's contents. `root` is the person's own drive root. */
export async function listFolder(
  accessToken: string, driveId: string, itemId: string,
): Promise<{ items?: CloudItem[]; error?: string }> {
  const base = itemId === "root" && !driveId ? "/me/drive/root" : itemPath(driveId, itemId);
  // A page of 200 with only the fields the list shows: the default page is 200
  // rows of forty fields each, most of which cross the wire to be discarded.
  const { body, error } = await get(accessToken,
    `${base}/children?$top=200&$select=id,name,size,lastModifiedDateTime,folder,file,parentReference,remoteItem`);
  if (error) return { error };
  return { items: browseListing((body?.value as never[]) ?? [], driveId) };
}

/** Search the whole of what this person can reach, not just the folder they are in. */
export async function searchFiles(
  accessToken: string, query: string,
): Promise<{ items?: CloudItem[]; error?: string }> {
  const q = query.trim();
  if (!q) return { items: [] };
  const { body, error } = await get(accessToken,
    `/me/drive/search(q='${encodeURIComponent(q.replace(/'/g, "''"))}')?$top=100`);
  if (error) return { error };
  return { items: searchListing((body?.value as never[]) ?? []) };
}

/** One item, for naming a download without trusting what the browser sent. */
export async function itemInfo(
  accessToken: string, driveId: string, itemId: string,
): Promise<{ item?: CloudItem; error?: string }> {
  const { body, error } = await get(accessToken, itemPath(driveId, itemId));
  if (error) return { error };
  const item = toCloudItem((body ?? {}) as never, driveId);
  return item ? { item } : { error: "Microsoft returned an item with no id." };
}

/**
 * The bytes.
 *
 * Streamed straight back to the caller rather than buffered: a packet's worth of
 * scans is tens of megabytes, and holding that in a serverless function to hand
 * it on unchanged is memory spent for nothing.
 */
export async function fileStream(
  accessToken: string, driveId: string, itemId: string,
): Promise<{ body?: ReadableStream<Uint8Array>; type?: string; error?: string }> {
  try {
    const res = await fetch(`${GRAPH}${itemPath(driveId, itemId)}/content`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      // Graph answers with a redirect to storage; following it is the download.
      redirect: "follow",
      signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
    });
    if (res.status === 401) return { error: "expired" };
    if (!res.ok || !res.body) return { error: `Microsoft answered ${res.status}.` };
    return { body: res.body, type: res.headers.get("content-type") ?? "application/pdf" };
  } catch (e) {
    return { error: `Could not reach Microsoft: ${(e as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Ask Microsoft for somewhere to put a finished packet.
 *
 * The returned upload URL is pre-authorized and takes no Authorization header,
 * which is the whole point: the browser PUTs the packet straight to Microsoft.
 * Sending it through this app instead would mean pushing tens of megabytes into
 * a serverless function that has a request-body ceiling well below the size of a
 * scanned sign-off packet, to hand the bytes on unchanged.
 *
 * `conflictBehavior: rename` rather than replace - overwriting a file somebody
 * else put in a shared folder, because the names happened to match, is not
 * something this app should be able to do by accident.
 */
export async function createUploadSession(
  accessToken: string, driveId: string, folderId: string, fileName: string,
): Promise<{ uploadUrl?: string; name?: string; error?: string }> {
  const name = safeFileName(fileName);
  try {
    const res = await fetch(
      `${GRAPH}${itemPath(driveId, folderId)}:/${encodeURIComponent(name)}:/createUploadSession`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "rename" } }),
        signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
      });
    if (res.status === 401) return { error: "expired" };
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { error: body?.error?.message || `Microsoft answered ${res.status}.` };
    }
    const { uploadUrl } = await res.json();
    return typeof uploadUrl === "string" ? { uploadUrl, name } : { error: "Microsoft started no upload." };
  } catch (e) {
    return { error: `Could not reach Microsoft: ${(e as Error).message}` };
  }
}
