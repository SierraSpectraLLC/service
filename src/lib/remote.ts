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
import { tenantOfOrg } from "@/lib/tenancy";
import { brandingFrom, type AgentBranding } from "@/lib/agentName";
import type { Notice } from "@/lib/fleetNotice";

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
export function namedGroups(meshes: unknown[], orgName: string): { _id: string; name: string }[] {
  return meshes.filter((m): m is { _id: string; name: string; mtype?: number } => {
    const g = m as { _id?: unknown; name?: unknown; mtype?: unknown };
    return typeof g?._id === "string" && g._id !== "" && typeof g?.name === "string"
      && g.name.trim().toLowerCase() === orgName.trim().toLowerCase()
      && (g.mtype === undefined || g.mtype === 2);
  });
}

export function pickExistingGroup(meshes: unknown[], orgName: string): string | null {
  const named = namedGroups(meshes, orgName);
  return named.length === 1 ? named[0]._id : null;
}

/**
 * The id a freshly created group reports, whichever way the host words it.
 *
 * Some versions answer createmesh with the new id, some answer "ok" and
 * nothing else, and the two are not distinguishable in advance. Reading every
 * shape here means the caller can tell "no id came back" from "the group was
 * not made", which are different problems with different fixes.
 */
export function createdGroupId(reply: Record<string, unknown>): string {
  const direct = reply.meshid ?? reply._id ?? reply.id;
  if (typeof direct === "string" && direct !== "") return direct;
  const nested = reply.mesh as { _id?: unknown; meshid?: unknown } | undefined;
  const inner = nested?._id ?? nested?.meshid;
  return typeof inner === "string" ? inner : "";
}

/**
 * The device group for an organization, created on first enrollment. One group per
 * org is the whole tenancy story: it is what keeps one client's machines
 * invisible to another, and it is why the group id is cached on `orgs`.
 */
export async function ensureOrgGroup(orgId: number): Promise<{ groupId: string } | { error: string }> {
  const cfg = remoteConfig();
  if (!cfg) return { error: NOT_CONFIGURED };
  const [org] = await db.select({
    name: orgs.name, groupId: orgs.remoteGroupId,
    parentOrgId: orgs.parentOrgId, isOperator: orgs.isOperator,
  }).from(orgs).where(eq(orgs.id, orgId));
  if (!org) return { error: "Not found" };
  if (org.groupId) return { groupId: org.groupId };
  const groupName = await engineGroupName(orgId, org);
  try {
    // Adopt a group already carrying this organization's name before making a
    // second one. Two ways to arrive here with one sitting there: somebody made
    // it by hand in the engine's own console, or a previous createmesh succeeded
    // and the write of its id didn't - and that second one would otherwise leave
    // a group per attempt, each holding machines the portal can't see.
    const listGroups = async () => {
      const seen = await engineCall(cfg, "meshes", {});
      return namedGroups(Array.isArray(seen.meshes) ? seen.meshes : [], groupName);
    };
    const existing = await listGroups();
    if (existing.length === 1) {
      await db.update(orgs).set({ remoteGroupId: existing[0]._id }).where(eq(orgs.id, orgId));
      return { groupId: existing[0]._id };
    }
    // Two groups wearing one name is not ours to resolve by picking - the wrong
    // guess files a client's machines where another client can see them. Say so
    // plainly, because the alternative is a button that never works and never
    // explains itself. (Repeated failed attempts are how a host ends up like
    // this, which is exactly why the id is re-read below rather than assumed.)
    if (existing.length > 1) {
      return { error:
        `The remote-support host has ${existing.length} device groups named "${groupName}". `
        + "Delete the extras there, leaving one, and try again - picking between them "
        + "could put this organization's machines in another's group." };
    }

    // meshtype 2 is a group of agent-managed machines, as opposed to Intel AMT
    // or agentless ones - the only kind this module deals in.
    const reply = await engineCall(cfg, "createmesh", { meshname: groupName, meshtype: 2 });
    let groupId = createdGroupId(reply);
    // Some hosts answer "ok" without the new id. The group exists either way,
    // so read it back by name rather than failing on a difference in wording -
    // and failing here is what left a fresh organization permanently unable to
    // make installation media while the older ones, whose ids were already
    // stored, went on working.
    if (!groupId) {
      const made = await listGroups();
      if (made.length === 1) groupId = made[0]._id;
    }
    if (!groupId) {
      return { error:
        `The host accepted the new device group "${groupName}" but did not report its id, `
        + "and it is not in the group list afterwards. Check that REMOTE_ADMIN_USER is a site "
        + "administrator with permission to create device groups." };
    }
    await db.update(orgs).set({ remoteGroupId: groupId }).where(eq(orgs.id, orgId));
    return { groupId };
  } catch (e) {
    return { error: `Couldn't reach the remote-support host: ${(e as Error).message}` };
  }
}


/**
 * What one organization's device group is called on the engine.
 *
 * Qualified by the service company that runs it, because the engine has one flat
 * namespace and groups are matched by name. Two operators each with a client
 * called "Acme" would otherwise adopt each other's group on first enrollment -
 * and a device group is exactly the boundary that keeps one client's machines
 * invisible to another, so that collision would put a lab PC within reach of a
 * company that has never heard of it.
 *
 * An operator's own group keeps its bare name: it is the one at the top.
 */
async function engineGroupName(
  orgId: number, org: { name: string; parentOrgId: number | null; isOperator: boolean },
): Promise<string> {
  const tenantId = org.isOperator ? orgId : org.parentOrgId;
  if (tenantId === null || tenantId === orgId) return org.name;
  const [tenant] = await db.select({ name: orgs.name }).from(orgs).where(eq(orgs.id, tenantId));
  return tenant?.name ? `${tenant.name} · ${org.name}` : org.name;
}

/**
 * A time-limited link that installs the agent into one organization's group.
 * Treat it like a password in transit - it is a capability to join that group,
 * which is why only staff can generate one (lib/remoteAccess.mayEnroll).
 */
export async function agentInstallerLink(
  remoteGroupId: string, hours = 24,
): Promise<{ url: string; groupId: string } | null> {
  const cfg = remoteConfig();
  if (!cfg || !remoteGroupId) return null;
  try {
    const reply = await engineCall(cfg, "createInviteLink", { meshid: remoteGroupId, expire: hours, flags: 0 });
    if (typeof reply.url !== "string") return null;
    // The engine names the group the link actually joins. The caller compares it
    // with the group it asked for, because this link decides which client's
    // roster a machine lands in and nothing downstream would notice a mismatch.
    return { url: reply.url, groupId: typeof reply.meshid === "string" ? reply.meshid : "" };
  } catch {
    return null;
  }
}

export type AgentDownload = { label: string; note: string; url: string; primary: boolean };

/**
 * Direct links to the installer for one organization's group, so the enrollment
 * instructions can be ours instead of the engine's page - which greets a client
 * with someone else's name, a stock screenshot and tabs for eleven operating
 * systems, nine of which no instrument controller has ever run.
 *
 * These need no session of their own: the engine personalizes the binary from the
 * group in the URL. That makes each link a capability to join that group, exactly
 * like an installer link, which is why the page holding them is staff-only.
 *
 * Agent numbers are the engine's own (4 = Windows x64, 43 = Windows on ARM,
 * 3 = 32-bit, 10006 = the tray-side Assistant).
 */
export function agentDownloads(remoteGroupId: string): AgentDownload[] {
  const cfg = remoteConfig();
  if (!cfg || !remoteGroupId) return [];
  const group = encodeURIComponent(bareEngineId(remoteGroupId));
  const at = (id: number) => `${cfg.url}/meshagents?id=${id}&meshid=${group}`;
  return [
    { label: "Windows 64-bit", note: "almost every instrument PC", url: at(4), primary: true },
    { label: "Windows on ARM", note: "Surface and other ARM laptops", url: at(43), primary: false },
    { label: "Windows 32-bit", note: "older controllers still on 32-bit Windows", url: at(3), primary: false },
    { label: "Assistant (optional)", note: "tray app so whoever is at the machine can see us", url: at(10006), primary: false },
  ];
}

/**
 * What the host would call the installer if somebody downloaded one now.
 *
 * The agent's branding - its window title, its Windows service name, its picture
 * and its file name - is baked into the binary by the support host as it serves
 * it, from settings in that host's own config. None of it is reachable from
 * here, and the failure mode is silent: the software works perfectly while
 * handing a client a file with somebody else's name on it.
 *
 * So ask. The id=4 download with no group attached is the cheap question - the
 * engine answers it by sending a file off disk rather than merging one - and the
 * name in its Content-Disposition header is the name it would brand a real
 * installer with. HEAD gets that header and no body; the GET is a fallback for
 * anything in the way that refuses HEAD, aborted the moment the header lands,
 * because reporting "looks fine" for want of a header would hide exactly the
 * problem this exists to catch.
 *
 * Null means "could not ask", which is deliberately not the same as "not
 * branded": a host that is down is not evidence that somebody forgot a setting.
 */
export async function agentBranding(): Promise<AgentBranding | null> {
  const cfg = remoteConfig();
  if (!cfg) return null;
  const url = `${cfg.url}/meshagents?id=4`;
  for (const method of ["HEAD", "GET"] as const) {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), ENGINE_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method, signal: stop.signal, redirect: "follow" });
      const branding = brandingFrom(res.headers.get("content-disposition"));
      stop.abort();            // the name is all we wanted; don't pull a few MB for it
      if (branding) return branding;
    } catch {
      return null;             // unreachable or timed out: retrying with GET won't help
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
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

// ── Notices on the machine's own screen ─────────────────────────────────────
//
// lib/fleetNotice decides WHAT a machine should say; this is the half that
// knows how to say it to MeshCentral 1.2.4. Read against agents/meshcore.js and
// meshuser.js of that version, the same way the cookie format above was.
//
// The engine gives us three ways to put words on a lab PC and only one of them
// is right for this:
//
//   * `toast` is a first-class control-API action, and transient - the agent
//     hands it to the OS notifier and forgets it. A repossession notice that
//     vanishes in ten seconds is not a notice.
//   * `messagebox`/`alertbox` are modal, and NOT reachable from the control API
//     at all - meshuser.js has no case for either. That is load-bearing rather
//     than inconvenient: lib/fleetNotice promises a rendering the agent cannot
//     make modal, and on this engine that promise is structural.
//   * `agentmsg add|remove|list` is a standing list the agent holds and shows
//     through its tray. That is the one that matches a notice, so it is the one
//     used here.
//
// `agentmsg` is an agent CONSOLE command, reached with `runcommands` type 4,
// which needs Remote Control (8) and Agent Console (16) on the node - the agent
// re-checks both itself before it will act. The list lives in memory on the
// agent (meshcore's sendAgentMessage closure), so it does NOT survive an agent
// restart, which is why api/cron/notices re-asserts rather than posting once.

/** The tray icon beside an agent message. 1 is the engine's warning triangle. */
const NOTICE_ICON = 1;

/** No message is worth breaking the command line over. */
const NOTICE_MAX_CHARS = 600;

/**
 * What survives the engine's own argument splitter.
 *
 * meshcore's splitArgs is `/[^\s"]+|"([^"]*)"/gi` - a quoted argument runs to
 * the next double quote and there is NO escape for one. So a notice containing
 * a quote would end its own argument early and the remainder would be parsed as
 * further arguments to `agentmsg`. Quotes become apostrophes and every run of
 * whitespace becomes one space, which also keeps a pasted multi-line notice on
 * the single line the console expects.
 */
export function consoleSafe(text: string): string {
  const flat = text.replace(/["\u201c\u201d]/g, "'").replace(/\s+/g, " ").trim();
  return flat.length > NOTICE_MAX_CHARS ? `${flat.slice(0, NOTICE_MAX_CHARS - 1).trimEnd()}\u2026` : flat;
}

/**
 * The exact console commands that leave a machine showing `notices` and nothing
 * else. Pure, so the quoting above is arguable in a test rather than only on a
 * customer's PC.
 *
 * Always clears first. The agent's list is additive - `agentmsg add` appends,
 * and there is no "replace" - so re-asserting without clearing would stack a
 * fourth copy of the same notice on a machine that had been up for four hours.
 * Clearing first also means an empty `notices` is a complete instruction:
 * "say nothing", which is what a cleared notice has to be able to say.
 *
 * The contact rides in the message text because an agent message is one string;
 * lib/fleetNotice keeps them apart so that a renderer WITH two fields can use
 * two, and this is the renderer that has one.
 */
export function agentMessageCommands(notices: Notice[]): string[] {
  const cmds = ["clearagentmsg"];
  for (const n of notices) {
    const line = n.contact ? `${n.text} (${n.contact})` : n.text;
    const safe = consoleSafe(line);
    if (safe) cmds.push(`agentmsg add "${safe}" ${NOTICE_ICON}`);
  }
  return cmds;
}

/**
 * Leave one machine showing exactly `notices`.
 *
 * Best-effort by contract: the database row is the record of what a machine
 * SHOULD say, and this is one attempt at making it say so. An offline agent,
 * an unreachable host and a revoked right all land here as an error the caller
 * is free to ignore, because api/cron/notices comes back around.
 *
 * One call per command - meshcore takes a single command per message
 * (splitArgs, then args[0]), so a newline-joined batch would be read as one
 * command with the rest as its arguments.
 *
 * `mayLockAtIdle` is deliberately not acted on. The engine's only idle signal
 * is `idletime`, which is Windows-only and measures seconds since keyboard or
 * mouse input - it cannot tell an unattended overnight acquisition from an
 * abandoned desk, and would fire the lock hardest during exactly the run
 * lib/fleetNotice is most anxious to protect. So the rung stays permission that
 * is never taken up, which is the degradation that module already allows for.
 */
export async function pushNoticesTo(nodeId: string, notices: Notice[]): Promise<{ error?: string }> {
  const cfg = remoteConfig();
  if (!cfg) return { error: NOT_CONFIGURED };
  if (!nodeId) return { error: "That machine has no node id yet." };
  try {
    for (const cmds of agentMessageCommands(notices)) {
      await engineCall(cfg, "runcommands", { nodeids: [nodeId], type: 4, runAsUser: 0, cmds });
    }
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
    node: bareEngineId(nodeId),            // the page prefixes the domain itself
    viewmode: "11",                        // straight to the desktop tab
    // Never the engine's phone layout. It sniffs the user agent and serves a
    // different template that has NO support for the hide bitmask at all
    // (verified against the pinned 1.2.4: default-mobile.handlebars never reads
    // it), so a phone got the full device tree - every client group by name,
    // which is a disclosure and not just an eyesore. mobile=0 forces the layout
    // that honours hide and viewmode (webserver.js:9955).
    mobile: "0",
  });
  // Inside our own page, strip the engine's furniture: its banner, its tab strip,
  // its footer and its panel headings, all of which duplicate or contradict ours.
  if (opts.embedded) q.set("hide", String(HIDE_ENGINE_CHROME));
  return `${cfg.url}/?${q.toString()}`;
}

/**
 * The engine's own chrome, summed: 1 banner, 2 tab strip, 4 footer, 8 panel
 * headings, 16 the left icon rail.
 *
 * 16 only lands when its page is in the layout it calls full screen, which is
 * its default - but that choice is remembered per browser, so a browser where
 * somebody once picked one of the other layouts keeps the rail. Theirs to unset,
 * not something we can send in a URL.
 */
const HIDE_ENGINE_CHROME = 1 | 2 | 4 | 8 | 16;

export const NOT_CONFIGURED =
  "Remote support has no host configured yet - set REMOTE_URL, REMOTE_LOGIN_KEY and REMOTE_ADMIN_USER.";

/**
 * Cache refresh: fold whatever the engine currently reports into `remote_devices`
 * so the list renders without it next time. Enrollment completes here rather than
 * through a webhook, which is why no route needs adding to the middleware
 * matcher: a machine that installed its agent appears the next time somebody
 * opens the page.
 */
export async function reconcileOrgDevices(orgId: number, live: EngineDevice[]): Promise<void> {
  // A machine belongs to the workspace that runs the organization it enrolled
  // into, so a device list can be scoped without a join.
  const tenantOrgId = await tenantOfOrg(orgId);
  const known = await db.select({ id: remoteDevices.id, nodeId: remoteDevices.nodeId })
    .from(remoteDevices).where(eq(remoteDevices.orgId, orgId));
  const byNode = new Map(known.map((k) => [k.nodeId, k.id]));
  const now = new Date();
  for (const d of live) {
    const id = byNode.get(d.nodeId);
    if (id === undefined) {
      await db.insert(remoteDevices).values({
        tenantOrgId,
        orgId, nodeId: d.nodeId, name: d.name, platform: d.platform || "windows",
        lastSeenAt: d.online ? now : null, enrolledBy: "the agent installer",
      }).onConflictDoNothing({ target: remoteDevices.nodeId });
    } else if (d.online) {
      await db.update(remoteDevices).set({ name: d.name, lastSeenAt: now }).where(eq(remoteDevices.id, id));
    }
  }
}

/**
 * The machine that drives one system, if a machine has been pointed at it. Read
 * by the system page so reaching the instrument's PC is a control on the
 * instrument, not a trip to a separate list to find it again.
 */
export async function linkedDevice(instrumentId: number) {
  const [row] = await db.select({
    id: remoteDevices.id,
    name: remoteDevices.name,
    orgId: remoteDevices.orgId,
    tenantOrgId: remoteDevices.tenantOrgId,
    lastSeenAt: remoteDevices.lastSeenAt,
    consentOverride: remoteDevices.consentOverride,
    instrumentId: remoteDevices.instrumentId,
    orgRemote: orgs.remoteAccessEnabled,
  }).from(remoteDevices)
    .leftJoin(orgs, eq(orgs.id, remoteDevices.orgId))
    .where(eq(remoteDevices.instrumentId, instrumentId))
    .limit(1)
    .catch(() => []);
  return row ?? null;
}

/** Devices with no organization yet - a machine enrolled before it was assigned. */
export async function orphanDevices() {
  return db.select().from(remoteDevices).where(isNull(remoteDevices.orgId));
}

/** One device with its org's group, for the connect path. */
/**
 * One enrolled machine, or null when it is gone OR belongs to another
 * workspace.
 *
 * The tenant is a parameter rather than a caller's afterthought because every
 * mutation on this table reaches the row through here, and the single-clause
 * `and()` this used to end on was the vestige of a predicate that was expected
 * and never written. Without it, `setRemoteConsent` over sequential ids turns
 * off the prompt on somebody else's instrument PC - the person sitting at that
 * machine stops being asked, and the audit line reads as though their own
 * company chose it.
 *
 * Undefined or null = no restriction: platform staff, and the pre-tenancy
 * instance.
 */
export async function deviceWithOrg(deviceId: number, tenantOrgId?: number | null) {
  const [row] = await db.select({
    device: remoteDevices,
    orgName: orgs.name,
    orgRemote: orgs.remoteAccessEnabled,
    groupId: orgs.remoteGroupId,
  }).from(remoteDevices)
    .leftJoin(orgs, eq(orgs.id, remoteDevices.orgId))
    .where(and(
      eq(remoteDevices.id, deviceId),
      tenantOrgId === undefined || tenantOrgId === null
        ? undefined
        : eq(remoteDevices.tenantOrgId, tenantOrgId),
    ));
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

/**
 * Ids on the engine read `node/<domain>/<hash>` and `mesh/<domain>/<hash>`, but
 * its URLs want the hash alone and prefix the rest themselves. Same shape for
 * both kinds, so one function.
 */
export function bareEngineId(id: string): string {
  const parts = id.split("/");
  return parts.length === 3 ? parts[2] : id;
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

type EngineReply = { responseid?: string; result?: string; action?: string } & Record<string, unknown>;

/**
 * Is this chatter on the control channel the answer to OUR command?
 *
 * Correlation is by `responseid` whenever the reply carries one, which is the
 * strict and obviously-correct case. But the engine does not echo the id on
 * every command: the device-group list is part of the state it volunteers the
 * moment a socket opens, and its explicit `meshes` handler answers the same
 * way - action named, no id attached. Insisting on the id there meant the
 * answer arrived, was ignored as somebody else's, and the call timed out with
 * "the host didn't answer 'meshes'" while the data sat in the buffer.
 *
 * So: an id that is not ours is never ours. A reply with no id at all is ours
 * when it names the action we asked for. The socket is opened per call and
 * closed on the first match, so nothing else of ours is ever in flight to
 * confuse it.
 */
export function isReplyTo(
  msg: { responseid?: unknown; action?: unknown } & Record<string, unknown>,
  action: string, responseid: string,
): boolean {
  if (typeof msg.responseid === "string") return msg.responseid === responseid;
  return msg.action === action;
}

/**
 * One admin command, one connection, closed immediately. The engine's admin API
 * is a WebSocket protocol rather than REST, which is workable from a serverless
 * function only in this shape: connect, send, await the one reply that carries
 * our id, hang up.
 *
 * The control channel is chatty - it volunteers server info, user lists and
 * event streams the moment it opens - so replies are correlated by isReplyTo
 * and everything else on the wire is ignored. Every caller treats a throw as
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
      if (!isReplyTo(msg, action, responseid)) return;
      // Case-folded because the engine is not consistent with itself: 22 of its
      // actions answer 'ok' and five - runcommands among them - answer 'OK'.
      // Compared exactly, a successful runcommands rejected with "OK" as the
      // error text, which is a confusing way to report that nothing went wrong.
      if (typeof msg.result === "string" && msg.result.toLowerCase() !== "ok") {
        const why = msg.result;
        finish(() => reject(new Error(why)));
        return;
      }
      finish(() => resolve(msg));
    };
  });
}

export { ENGINE_TIMEOUT_MS };
