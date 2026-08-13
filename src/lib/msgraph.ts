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
import { appUrl } from "@/lib/appUrl";

export const NOT_CONFIGURED =
  "OneDrive is not set up on this instance yet. An owner adds the Microsoft app registration in the environment.";

/** Delegated scopes. `offline_access` is what makes the connection outlive the browser tab. */
export const SCOPES = [
  "offline_access", "openid", "profile", "User.Read",
  "Files.ReadWrite.All", "Sites.Read.All",
  // Teams. A team's files are not in anybody's OneDrive - every team is backed
  // by a SharePoint site, and "Files > General" is a folder in that site's
  // document library. Without this the one place a shop actually keeps its
  // documents is the one place this browser could not see.
  "Team.ReadBasic.All",
];

/**
 * Scopes this app now needs that a connection was never granted.
 *
 * A connection made before a scope was added keeps working for everything it was
 * approved for and quietly does nothing for the new thing - so somebody who
 * connected last week would open the browser, see no Teams, and have no way to
 * know that reconnecting was the fix. Microsoft also refuses the refresh once a
 * request asks for a scope nobody consented to, so a stale connection is dead
 * anyway; this is what makes it say so in words.
 *
 * Compared on the last path segment because Microsoft echoes scopes back
 * sometimes short (`Files.ReadWrite.All`) and sometimes fully qualified. A blank
 * string means the token response never said, which is not evidence of anything.
 */
export function missingScopes(granted: string): string[] {
  const short = (s: string) => (s.split("/").pop() ?? "").toLowerCase();
  const have = new Set(granted.split(/[\s,]+/).filter(Boolean).map(short));
  if (!have.size) return [];
  // openid, profile and offline_access are not consistently echoed back, and
  // none of them is what makes a feature appear or not.
  return SCOPES.filter((s) => s.includes(".") && !have.has(short(s)));
}

export const RECONNECT_FOR_SCOPES =
  "This connection was made before team files were supported. Connect again to reach Teams and SharePoint.";

/** Graph calls get a ceiling: a slow tenant must not hang a page render. */
const GRAPH_TIMEOUT_MS = 12_000;

export type GraphConfig = { clientId: string; clientSecret: string; tenant: string; redirectUri: string };

/**
 * Where Microsoft sends somebody back to.
 *
 * Through the shared appUrl(), which already knows about Vercel's own
 * production URL - deriving it separately here is what made this feature
 * silently invisible on an instance that had every Microsoft variable set and no
 * APP_URL, since a missing redirect URI made the whole config null.
 */
export function graphBaseUrl(): string {
  return (appUrl() || process.env.AUTH_URL || process.env.NEXTAUTH_URL || "").replace(/\/+$/, "");
}

/**
 * `MS_TENANT` is `common` for "whichever tenant the person signs in to", or a
 * specific tenant id to lock this to one company. Defaulting to `common` is what
 * lets a client's own OneDrive be reachable at all - with a fixed tenant, only
 * Sierra's own accounts could ever connect.
 */
export function graphConfig(): GraphConfig | null {
  const clientId = process.env.MS_CLIENT_ID ?? "";
  const clientSecret = process.env.MS_CLIENT_SECRET ?? "";
  const base = graphBaseUrl();
  if (!clientId || !clientSecret || !base) return null;
  return {
    clientId, clientSecret,
    tenant: process.env.MS_TENANT || "common",
    redirectUri: `${base}/api/cloud/callback`,
  };
}

export const graphConfigured = () => graphConfig() !== null;

/**
 * Why this is not working, in words, or "" when it is.
 *
 * Exists because the first version of this feature simply did not appear when it
 * was half-configured: somebody set four environment variables, saw nothing at
 * all, and had no way to tell whether they had missed a step or hit a bug. A
 * capability that hides its own misconfiguration cannot be set up by anyone but
 * the person who wrote it.
 *
 * Shown to staff only - it names environment variables, which is a debugging
 * aid for whoever runs the instance and noise to everybody else.
 */
export function graphSetupProblem(): string {
  const missing: string[] = [];
  if (!process.env.MS_CLIENT_ID) missing.push("MS_CLIENT_ID");
  if (!process.env.MS_CLIENT_SECRET) missing.push("MS_CLIENT_SECRET");
  if (missing.length) return `OneDrive needs ${missing.join(" and ")} in the environment.`;
  if (!graphBaseUrl()) {
    return "OneDrive is configured, but this instance does not know its own address - "
      + "set APP_URL to the portal's URL so Microsoft has somewhere to send people back to.";
  }
  return "";
}

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

/** The drive that stands for "shared with me" rather than a real drive id. */
export const SHARED_DRIVE = "\u0000shared";

/**
 * One item's path. `root` is a named position, not an id, so it addresses
 * `/root` - `/items/root` is not a thing Graph accepts, and getting that wrong
 * breaks every drive except the signed-in person's own.
 */
const itemPath = (driveId: string, itemId: string) => {
  const drive = driveId ? `/drives/${encodeURIComponent(driveId)}` : "/me/drive";
  return itemId === "root" ? `${drive}/root` : `${drive}/items/${encodeURIComponent(itemId)}`;
};

/** One folder's contents. `root` is the person's own drive root. */
export async function listFolder(
  accessToken: string, driveId: string, itemId: string,
): Promise<{ items?: CloudItem[]; error?: string }> {
  // Things other people shared are not children of anything - they are their own
  // list, and every row is a pointer at an item on somebody else's drive.
  // toCloudItem already follows those (remoteItem), which is what makes a shared
  // folder openable rather than a dead row.
  if (driveId === SHARED_DRIVE) {
    const { body, error } = await get(accessToken, "/me/drive/sharedWithMe");
    if (error) return { error };
    return { items: browseListing((body?.value as never[]) ?? []) };
  }
  const base = itemPath(driveId, itemId);
  // A page of 200 with only the fields the list shows: the default page is 200
  // rows of forty fields each, most of which cross the wire to be discarded.
  const { body, error } = await get(accessToken,
    `${base}/children?$top=200&$select=id,name,size,lastModifiedDateTime,folder,file,parentReference,remoteItem`);
  if (error) return { error };
  return { items: browseListing((body?.value as never[]) ?? [], driveId) };
}

/**
 * The places somebody can look, which is the thing this browser got wrong.
 *
 * It listed the signed-in person's own OneDrive and stopped - so a shop that
 * keeps every document in a Team saw an empty list and reasonably concluded the
 * feature was broken. A team's files are in the SharePoint site behind the team,
 * not in anybody's personal drive, and a folder somebody shared is in a third
 * place again.
 *
 * Each entry is a folder whose driveId points at a different store. Anything
 * that fails is left out rather than failing the whole list: a tenant that will
 * not answer for teams should still show a person their own files.
 */
export async function listPlaces(accessToken: string): Promise<{ items?: CloudItem[]; error?: string }> {
  const place = (id: string, name: string, driveId: string): CloudItem =>
    ({ id, name, isFolder: true, size: 0, modified: "", childCount: 0, driveId });

  const items: CloudItem[] = [
    place("root", "My files", ""),
    place("root", "Shared with me", SHARED_DRIVE),
  ];

  const { body } = await get(accessToken, "/me/joinedTeams?$select=id,displayName");
  const teams = (body?.value as { id?: string; displayName?: string }[] | undefined) ?? [];
  for (const t of teams) {
    if (!t.id) continue;
    // The team's own document library. Asked for per team because the id that
    // addresses the files is the drive's, not the team's.
    const { body: drive } = await get(accessToken, `/groups/${encodeURIComponent(t.id)}/drive?$select=id`);
    const driveId = typeof drive?.id === "string" ? drive.id : "";
    if (driveId) items.push(place("root", t.displayName || "Team", driveId));
  }
  return { items };
}

/**
 * Search a whole store, not just the folder somebody is standing in.
 *
 * Scoped to the drive being browsed, because "search" that always meant the
 * signed-in person's own OneDrive answered nothing at all for a shop whose
 * documents live in a Team - the same failure as the browser starting there.
 */
export async function searchFiles(
  accessToken: string, query: string, driveId = "",
): Promise<{ items?: CloudItem[]; error?: string }> {
  const q = query.trim();
  if (!q) return { items: [] };
  const real = driveId && driveId !== SHARED_DRIVE ? driveId : "";
  const base = real ? `/drives/${encodeURIComponent(real)}` : "/me/drive";
  const { body, error } = await get(accessToken,
    `${base}/root/search(q='${encodeURIComponent(q.replace(/'/g, "''"))}')?$top=100`);
  if (error) return { error };
  return { items: searchListing((body?.value as never[]) ?? [], real) };
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
