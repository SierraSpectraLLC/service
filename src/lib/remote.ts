// The boundary between this portal and the remote-support engine.
//
// Everything that knows the engine's wire format lives here and nowhere else, so
// swapping engines - or moving off the relay host - is one file. Server-only:
// lib/remoteAccess holds the decisions, and it is pure so it can be tested.
//
// ── Shape of the thing ──────────────────────────────────────────────────────
// Vercel functions cannot hold a socket open (the notification poller concedes
// the same thing), so the portal is never in the media path. It only:
//   1. decides who may connect        - lib/remoteAccess
//   2. writes down that they did      - lib/audit
//   3. hands the browser a short-lived URL to the relay host
// The session itself is browser <-> relay <-> agent. Nothing of ours is held
// open, and the agent reaches us by checking in, because a lab PC behind NAT has
// no address we could dial.
//
// ── What is NOT finished here ───────────────────────────────────────────────
// `mintAuthCookie` below is the one piece whose exact byte format has to be
// confirmed against the pinned engine build during the Phase 0 spike. It is
// deliberately left throwing rather than guessed at: a plausible-looking
// implementation of somebody else's crypto format is the worst kind of done -
// it typechecks, ships, and fails at the only moment that matters. See
// docs/PROVISIONING.md.
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { orgs, remoteDevices } from "@/db/schema";

/** How long a connect URL is good for. Bounds the START of a session, not its length. */
export const CONNECT_TTL_SECONDS = 120;

/** Engine calls get a hard ceiling - a hung relay must not hang a page render. */
const ENGINE_TIMEOUT_MS = 5000;

export type RemoteConfig = { url: string; loginKey: string; adminUser: string };

/**
 * The relay host is an env var, not an architecture. The agent tries a direct
 * peer connection first and falls back to the relay, so if a better option
 * appears we point at it rather than rewriting anything.
 */
export function remoteConfig(): RemoteConfig | null {
  const url = (process.env.REMOTE_URL ?? "").replace(/\/+$/, "");
  const loginKey = process.env.REMOTE_LOGIN_KEY ?? "";
  const adminUser = process.env.REMOTE_ADMIN_USER ?? "";
  if (!url || !loginKey || !adminUser) return null;
  return { url, loginKey, adminUser };
}

/**
 * True when this instance has somewhere to connect TO. The module flag and this
 * are separate on purpose: an owner can switch the module on before the relay
 * host exists, and the page should say "not configured yet" rather than break.
 */
export const remoteConfigured = () => remoteConfig() !== null;

export type EngineDevice = {
  nodeId: string;
  name: string;
  online: boolean;
  platform: string;
};

/**
 * Live device state for one organization's group, or `null` when the engine
 * cannot be reached. Null is not an error to surface - the caller falls back to
 * the cached rows in `remote_devices` and says the state is last-known, which is
 * the same posture every other shell-level read in this app takes.
 */
export async function listGroupDevices(remoteGroupId: string): Promise<EngineDevice[] | null> {
  const cfg = remoteConfig();
  if (!cfg || !remoteGroupId) return null;
  try {
    return await engineCall<EngineDevice[]>(cfg, "listdevices", { group: remoteGroupId });
  } catch {
    return null;
  }
}

/**
 * The device group for an organization, created on first enrolment. One group per
 * org is the whole tenancy story: it is what keeps one client's machines
 * invisible to another, and it is why the group id is cached on `orgs`.
 */
export async function ensureOrgGroup(orgId: number): Promise<{ groupId: string } | { error: string }> {
  const cfg = remoteConfig();
  if (!cfg) return { error: NOT_CONFIGURED };
  const [org] = await db.select({ name: orgs.name, groupId: orgs.remoteGroupId }).from(orgs).where(eq(orgs.id, orgId));
  if (!org) return { error: "Not found" };
  if (org.groupId) return { groupId: org.groupId };
  try {
    const made = await engineCall<{ groupId: string }>(cfg, "adddevicegroup", { name: org.name });
    await db.update(orgs).set({ remoteGroupId: made.groupId }).where(eq(orgs.id, orgId));
    return { groupId: made.groupId };
  } catch (e) {
    return { error: `Couldn't reach the remote-support host: ${(e as Error).message}` };
  }
}

/**
 * A time-limited link that installs the agent into one organization's group.
 * Treat it like a password in transit - it is a capability to join that group,
 * which is why only staff can generate one (lib/remoteAccess.mayEnroll).
 */
export async function agentInstallerLink(remoteGroupId: string, hours = 24): Promise<string | null> {
  const cfg = remoteConfig();
  if (!cfg || !remoteGroupId) return null;
  try {
    const r = await engineCall<{ url: string }>(cfg, "generateinvitelink", { group: remoteGroupId, hours });
    return r.url;
  } catch {
    return null;
  }
}

/**
 * Where to send the browser. Deliberately does NOT call the engine: the hot path
 * stays usable when the admin API is unreachable, because the cookie is minted
 * locally from the shared key. Pressing Connect must not depend on the flakiest
 * part of the integration.
 *
 * `consent` decides whether the far end gets a prompt. It comes from
 * lib/remoteAccess.consentModeFor, which derives it from custody.
 */
export function connectUrl(nodeId: string, opts: { consent: boolean }): string | { error: string } {
  const cfg = remoteConfig();
  if (!cfg) return { error: NOT_CONFIGURED };
  let auth: string;
  try {
    auth = mintAuthCookie(cfg, cfg.adminUser, CONNECT_TTL_SECONDS);
  } catch (e) {
    return { error: (e as Error).message };
  }
  const q = new URLSearchParams({
    node: nodeId,
    viewmode: "11",                        // straight to the desktop tab
    auth,
    consent: opts.consent ? "1" : "0",
  });
  return `${cfg.url}/?${q.toString()}`;
}

export const NOT_CONFIGURED =
  "Remote support has no host configured yet - set REMOTE_URL, REMOTE_LOGIN_KEY and REMOTE_ADMIN_USER.";

/**
 * Cache refresh: fold whatever the engine currently reports into `remote_devices`
 * so the list renders without it next time. Enrolment completes here rather than
 * through a webhook, which is why no route needs adding to the middleware
 * matcher: a machine that installed its agent appears the next time somebody
 * opens the page.
 */
export async function reconcileOrgDevices(orgId: number, live: EngineDevice[]): Promise<void> {
  const known = await db.select({ id: remoteDevices.id, nodeId: remoteDevices.nodeId })
    .from(remoteDevices).where(eq(remoteDevices.orgId, orgId));
  const byNode = new Map(known.map((k) => [k.nodeId, k.id]));
  const now = new Date();
  for (const d of live) {
    const id = byNode.get(d.nodeId);
    if (id === undefined) {
      await db.insert(remoteDevices).values({
        orgId, nodeId: d.nodeId, name: d.name, platform: d.platform || "windows",
        lastSeenAt: d.online ? now : null, enrolledBy: "the agent installer",
      }).onConflictDoNothing({ target: remoteDevices.nodeId });
    } else if (d.online) {
      await db.update(remoteDevices).set({ name: d.name, lastSeenAt: now }).where(eq(remoteDevices.id, id));
    }
  }
}

/** Devices with no organization yet - a machine enrolled before it was assigned. */
export async function orphanDevices() {
  return db.select().from(remoteDevices).where(isNull(remoteDevices.orgId));
}

/** One device with its org's group, for the connect path. */
export async function deviceWithOrg(deviceId: number) {
  const [row] = await db.select({
    device: remoteDevices,
    orgName: orgs.name,
    orgRemote: orgs.remoteAccessEnabled,
    groupId: orgs.remoteGroupId,
  }).from(remoteDevices)
    .leftJoin(orgs, eq(orgs.id, remoteDevices.orgId))
    .where(and(eq(remoteDevices.id, deviceId)));
  return row ?? null;
}

// ── Engine wire format ──────────────────────────────────────────────────────

/**
 * NOT IMPLEMENTED, on purpose.
 *
 * The engine authenticates a browser by an encrypted cookie keyed on the shared
 * `loginCookieEncryptionKey`. Reproducing that format is a Phase 0 task, done
 * against the exact pinned build with a round-trip test, because the format has
 * changed between engine releases and there is no way to verify it from here.
 *
 * Until then every caller degrades honestly: `connectUrl` returns this message,
 * the Connect button shows it, and nothing pretends to work.
 */
function mintAuthCookie(_cfg: RemoteConfig, _userId: string, _ttlSeconds: number): string {
  throw new Error(
    "The remote-support session token isn't implemented yet - it needs verifying "
    + "against the pinned engine build during setup (see docs/PROVISIONING.md).",
  );
}

/**
 * One admin command, one connection, closed immediately. The engine's admin API
 * is a WebSocket protocol rather than REST, which is workable from a serverless
 * function only in this shape: connect, send, await one reply, hang up.
 *
 * Also unimplemented until Phase 0 pins the build - same reasoning as above.
 * Callers already treat a throw as "engine unreachable" and fall back to cache,
 * so the pages behave correctly in the meantime.
 */
async function engineCall<T>(_cfg: RemoteConfig, command: string, _args: Record<string, unknown>): Promise<T> {
  await Promise.resolve();
  throw new Error(`The remote-support host isn't wired up yet (${command}); finish setup first.`);
}

export { ENGINE_TIMEOUT_MS };
