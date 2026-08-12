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
// ── Which build this is written against ─────────────────────────────────────
// MeshCentral 1.2.4, read rather than guessed at. Three details in it are
// version-specific, and all three have moved between releases:
//
//   * the login key is 80 bytes - `meshcentral.js` decodes the hex and rejects
//     any other length with a warning, then quietly uses a key of its own, so a
//     wrong length looks healthy and fails only at connect time
//   * a token is AES-256-GCM over JSON with the first 32 bytes of that key,
//     laid out iv(12) | tag(16) | ciphertext, base64 with `+` and `/` swapped
//     for `@` and `$`
//   * the browser page reads it from `?login=`, the admin channel from `?auth=`
//     - same bytes, different parameter names
//
// Upgrading the host means re-reading `encodeCookie`/`decodeCookieAESGCM` in
// meshcentral.js and re-running tests/remoteCookie.test.ts. See
// docs/REMOTE_HOST_SETUP.md.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { orgs, remoteDevices } from "@/db/schema";

/** How long a connect URL is good for. Bounds the START of a session, not its length. */
export const CONNECT_TTL_SECONDS = 120;

/** Engine calls get a hard ceiling - a hung relay must not hang a page render. */
const ENGINE_TIMEOUT_MS = 5000;

/** The engine's login key, in bytes and in the hex we store it as. Not negotiable: it length-checks. */
export const ENGINE_KEY_BYTES = 80;
export const ENGINE_KEY_HEX_CHARS = ENGINE_KEY_BYTES * 2;

/**
 * What the far end sees. Bits are the engine's, summed: 1/2/4 notify for
 * desktop/terminal/files, 8/16/32 prompt for the same three.
 *
 * `unattended` is notify-only rather than silent on purpose - a bench PC in our
 * own shop still says out loud that somebody is on it, which costs nothing and
 * is the difference between remote support and surveillance.
 */
export const CONSENT_FLAGS = { unattended: 1 | 2 | 4, consent: 1 | 2 | 4 | 8 | 16 | 32 } as const;

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
    const reply = await engineCall(cfg, "nodes", { meshid: remoteGroupId });
    // The reply is keyed by device group, even when one group was asked for.
    const byGroup = (reply.nodes ?? {}) as Record<string, EngineNode[]>;
    return Object.values(byGroup).flat().map((n) => ({
      nodeId: String(n._id ?? ""),
      name: String(n.name ?? n.rname ?? "unnamed"),
      // Connectivity is a bitmask; bit 1 is "the agent is talking to us".
      online: ((typeof n.conn === "number" ? n.conn : 0) & 1) !== 0,
      platform: String(n.osdesc ?? "windows"),
    })).filter((d) => d.nodeId !== "");
  } catch {
    return null;
  }
}

/** Only the fields we read. The engine sends a great deal more per device. */
type EngineNode = { _id?: string; name?: string; rname?: string; conn?: number; osdesc?: string };

/**
 * The group already named for an organization, if there is exactly one. Exactly
 * one on purpose: two groups wearing the same name is an ambiguity a machine
 * should not resolve by picking, because the wrong guess files a client's PC
 * where another client can see it. Pure so the rule is testable without a host.
 *
 * `mtype` 2 is the agent-managed kind; the engine's other group types can share a
 * name without meaning the same thing.
 */
export function pickExistingGroup(meshes: unknown[], orgName: string): string | null {
  const named = meshes.filter((m): m is { _id: string; name: string; mtype?: number } => {
    const g = m as { _id?: unknown; name?: unknown; mtype?: unknown };
    return typeof g?._id === "string" && g._id !== "" && typeof g?.name === "string"
      && g.name.trim().toLowerCase() === orgName.trim().toLowerCase()
      && (g.mtype === undefined || g.mtype === 2);
  });
  return named.length === 1 ? named[0]._id : null;
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
    // Adopt a group already carrying this organization's name before making a
    // second one. Two ways to arrive here with one sitting there: somebody made
    // it by hand in the engine's own console, or a previous createmesh succeeded
    // and the write of its id didn't - and that second one would otherwise leave
    // a group per attempt, each holding machines the portal can't see.
    const seen = await engineCall(cfg, "meshes", {});
    const adopted = pickExistingGroup(Array.isArray(seen.meshes) ? seen.meshes : [], org.name);
    if (adopted) {
      await db.update(orgs).set({ remoteGroupId: adopted }).where(eq(orgs.id, orgId));
      return { groupId: adopted };
    }
    // meshtype 2 is a group of agent-managed machines, as opposed to Intel AMT
    // or agentless ones - the only kind this module deals in.
    const reply = await engineCall(cfg, "createmesh", { meshname: org.name, meshtype: 2 });
    const groupId = typeof reply.meshid === "string" ? reply.meshid : "";
    if (!groupId) return { error: "The remote-support host didn't return a device group id." };
    await db.update(orgs).set({ remoteGroupId: groupId }).where(eq(orgs.id, orgId));
    return { groupId };
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
    const reply = await engineCall(cfg, "createInviteLink", { meshid: remoteGroupId, expire: hours, flags: 0 });
    return typeof reply.url === "string" ? reply.url : null;
  } catch {
    return null;
  }
}

/**
 * Set what the far end sees before a session opens: a notification, or a prompt
 * it has to accept. The engine holds this per machine and applies it when the
 * session starts, so it is a property of the device rather than of the link -
 * which is why it is set here and not passed in the URL.
 *
 * Failing to turn a prompt ON must block the connection; failing to turn one OFF
 * must not. Both directions of that asymmetry favour the person at the keyboard,
 * so the caller can treat a failure as a refusal without thinking about it.
 */
export async function applyDeviceConsent(nodeId: string, mode: "consent" | "unattended"): Promise<{ error?: string }> {
  const cfg = remoteConfig();
  if (!cfg) return { error: NOT_CONFIGURED };
  try {
    await engineCall(cfg, "changedevice", { nodeid: nodeId, consent: CONSENT_FLAGS[mode] });
    return {};
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/**
 * Where to send the browser. Deliberately does NOT call the engine: the hot path
 * stays usable when the admin API is unreachable, because the token is minted
 * locally from the shared key. Pressing Connect must not depend on the flakiest
 * part of the integration.
 */
export function connectUrl(nodeId: string, opts: { embedded?: boolean } = {}): string | { error: string } {
  const cfg = remoteConfig();
  if (!cfg) return { error: NOT_CONFIGURED };
  let login: string;
  try {
    login = mintEngineToken(cfg, CONNECT_TTL_SECONDS);
  } catch (e) {
    return { error: (e as Error).message };
  }
  const q = new URLSearchParams({
    login,                                 // the page's parameter; the admin channel uses ?auth=
    node: bareNodeId(nodeId),              // the page prefixes the domain itself
    viewmode: "11",                        // straight to the desktop tab
  });
  // Inside our own page, strip the engine's furniture: its banner, its tab strip,
  // its footer and its panel headings, all of which duplicate or contradict ours.
  if (opts.embedded) q.set("hide", String(HIDE_ENGINE_CHROME));
  return `${cfg.url}/?${q.toString()}`;
}

/** The engine's own chrome, summed: 1 banner, 2 tab strip, 4 footer, 8 panel headings. */
const HIDE_ENGINE_CHROME = 1 | 2 | 4 | 8;

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
//
// From here down is somebody else's format, reproduced exactly. Everything is
// exported so tests can round-trip it, because "it typechecks" is worth nothing
// here - the only proof that matters is that the bytes decode the way the
// engine's own decoder decodes them.

/**
 * How an account is named on the engine: `user/<domain>/<name>`, lowercased,
 * with an empty domain for the default one. The engine looks the account up by
 * this exact string and silently fails the login if it doesn't match, so the
 * shape matters more than it looks.
 */
export function engineUserId(name: string, domainId = ""): string {
  return name.includes("/") ? name : `user/${domainId}/${name.toLowerCase()}`;
}

/** The engine prefixes the domain onto the node id in a page URL, so hand it the bare part. */
export function bareNodeId(nodeId: string): string {
  const parts = nodeId.split("/");
  return parts.length === 3 ? parts[2] : nodeId;
}

/**
 * A token the engine will accept as proof of who is calling. AES-256-GCM over
 * the JSON payload, using the first 32 bytes of the 80-byte shared key, with the
 * creation time in seconds and an expiry in whole minutes - both fields the
 * engine's decoder insists on reading.
 *
 * `nowMs` is injectable for tests only; nothing else should pass it.
 */
export function encodeEngineCookie(
  payload: Record<string, unknown>, keyHex: string, nowMs: number = Date.now(),
): string {
  const key = engineKey(keyHex);
  const body = JSON.stringify({ ...payload, time: Math.floor(nowMs / 1000) });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key.subarray(0, 32), iv);
  const sealed = Buffer.concat([cipher.update(body, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed])
    .toString("base64").replace(/\+/g, "@").replace(/\//g, "$");
}

/**
 * The mirror of the above, with the engine's own acceptance rules: a bad tag, a
 * missing time, an expired token and a token from the future all come back
 * `null` rather than throwing. Not needed to connect - it exists so the tests
 * prove the format, and so a support call can be answered by decoding the token
 * somebody was actually handed.
 */
export function decodeEngineCookie(
  cookie: string, keyHex: string, nowMs: number = Date.now(),
): Record<string, unknown> | null {
  try {
    const key = engineKey(keyHex);
    const raw = Buffer.from(cookie.replace(/@/g, "+").replace(/\$/g, "/"), "base64");
    if (raw.length < 29) return null;
    const decipher = createDecipheriv("aes-256-gcm", key.subarray(0, 32), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const o = JSON.parse(decipher.update(raw.subarray(28), undefined, "utf8") + decipher.final("utf8"));
    if (typeof o.time !== "number" || o.time === 0) return null;
    const age = nowMs - o.time * 1000;
    // Thirty seconds of tolerance for a host whose clock runs a little fast -
    // the engine allows exactly this much, and no more.
    const window = (typeof o.expire === "number" ? o.expire : 2) * 60_000;
    if (o.expire !== 0 && (age > window || age < -30_000)) return null;
    return o;
  } catch {
    return null;
  }
}

/** A login token for the portal's service identity, good for `ttlSeconds`. */
export function mintEngineToken(cfg: RemoteConfig, ttlSeconds: number, nowMs: number = Date.now()): string {
  return encodeEngineCookie({
    u: engineUserId(cfg.adminUser),
    a: 3,                                              // 3 is "this is a login token"
    expire: Math.max(1, Math.ceil(ttlSeconds / 60)),   // the engine counts in minutes
  }, cfg.loginKey, nowMs);
}

/**
 * The shared key, checked here rather than at the point of failure. Getting the
 * length wrong is the one setup mistake that leaves a working-looking host
 * refusing every link, so the message says the number.
 */
function engineKey(keyHex: string): Buffer {
  const clean = keyHex.trim();
  if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length !== ENGINE_KEY_HEX_CHARS) {
    throw new Error(
      `REMOTE_LOGIN_KEY must be ${ENGINE_KEY_HEX_CHARS} hex characters (${ENGINE_KEY_BYTES} bytes) `
      + `to match the remote-support host; this one is ${clean.length}. `
      + `Generate one with: openssl rand -hex ${ENGINE_KEY_BYTES}`,
    );
  }
  return Buffer.from(clean, "hex");
}

type EngineReply = { responseid?: string; result?: string } & Record<string, unknown>;

/**
 * One admin command, one connection, closed immediately. The engine's admin API
 * is a WebSocket protocol rather than REST, which is workable from a serverless
 * function only in this shape: connect, send, await the one reply that carries
 * our id, hang up.
 *
 * The control channel is chatty - it volunteers server info, user lists and
 * event streams the moment it opens - so correlation is by `responseid` and
 * everything else on the wire is ignored. Every caller treats a throw as
 * "engine unreachable" and degrades, so nothing here needs to succeed for a page
 * to render.
 */
async function engineCall(
  cfg: RemoteConfig, action: string, args: Record<string, unknown> = {},
): Promise<EngineReply> {
  if (typeof WebSocket === "undefined") {
    throw new Error("this runtime has no WebSocket, so the remote-support host can't be reached from it");
  }
  const token = mintEngineToken(cfg, CONNECT_TTL_SECONDS);
  const url = `${cfg.url.replace(/^http/, "ws")}/control.ashx?auth=${encodeURIComponent(token)}`;
  const responseid = `portal-${randomBytes(6).toString("hex")}`;

  return new Promise<EngineReply>((resolve, reject) => {
    const ws = new WebSocket(url);
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already gone */ }
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error(`the host didn't answer '${action}' within ${ENGINE_TIMEOUT_MS}ms`))),
      ENGINE_TIMEOUT_MS,
    );

    ws.onopen = () => ws.send(JSON.stringify({ action, ...args, responseid }));
    ws.onerror = () => finish(() => reject(new Error("couldn't reach the remote-support host")));
    // A rejected token looks exactly like this: the socket opens, the engine says
    // its piece, and closes without ever answering us.
    ws.onclose = () => finish(() => reject(new Error(
      "the host closed the connection without answering - check that REMOTE_ADMIN_USER exists there "
      + "as a site administrator and that REMOTE_LOGIN_KEY matches its config.json",
    )));
    ws.onmessage = (ev: MessageEvent) => {
      let msg: EngineReply;
      try { msg = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)); } catch { return; }
      if (msg.responseid !== responseid) return;
      if (typeof msg.result === "string" && msg.result !== "ok") {
        const why = msg.result;
        finish(() => reject(new Error(why)));
        return;
      }
      finish(() => resolve(msg));
    };
  });
}

export { ENGINE_TIMEOUT_MS };
