// Event notifications (email via Resend). Deliberately just two events - the
// daily digest covers routine status. Every send is wrapped so a mail failure
// can never fail the action that triggered it.
import { db } from "@/db";
import { users, people } from "@/db/schema";
import { parseList } from "@/lib/allowMatch";
import { sendEmail } from "@/lib/email";

export type Person = { name: string; email: string };

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const appUrl = () =>
  process.env.APP_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "");

/**
 * Assignees/mentions are freeform names ("Joe", "Thomas", "Chris Ma").
 * Resolve to an email by (1) the people roster (Settings), (2) exact
 * users.name match, then (3) a staff email whose local part starts with the
 * name (joe -> joe.vincent96@...). Null when nothing matches - the caller
 * skips the notification rather than guessing.
 */
export function resolveAssigneeEmail(
  name: string,
  staffEmails: string[],
  userRows: { name: string | null; email: string }[],
  roster: Person[] = [],
): string | null {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  const inRoster = roster.find((p) => p.name.trim().toLowerCase() === n && p.email.trim());
  if (inRoster) return inRoster.email.trim().toLowerCase();
  const byName = userRows.find((u) => (u.name || "").trim().toLowerCase() === n);
  if (byName) return byName.email.toLowerCase();
  return staffEmails.find((e) => e.split("@")[0].startsWith(n)) ?? null;
}

/**
 * Which roster names does a post @mention? A name matches on its full form
 * ("@Chris Ma") or its first word ("@Chris"), case-insensitive.
 */
export function parseMentions(body: string, names: string[]): string[] {
  const lc = body.toLowerCase();
  return names.filter((raw) => {
    const full = raw.trim().toLowerCase();
    if (!full) return false;
    const first = full.split(/\s+/)[0];
    return lc.includes("@" + full) || lc.includes("@" + first);
  });
}

const wrap = (body: string) => `
  <div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#172A4A;">
    <div style="font-weight:bold;letter-spacing:0.3px;margin-bottom:10px;">SIERRA SPECTRA</div>
    ${body}
  </div>`;

export async function notifyTaskAssigned(opts: {
  actorEmail: string; actorName: string; assignee: string;
  // A task lives on a system, on a standalone asset, or both - the link points
  // at whichever page owns it.
  taskTitle: string; instrumentId?: number; assetId?: number; externalId: string;
}) {
  try {
    const staff = parseList(process.env.STAFF_EMAILS);
    const [userRows, roster] = await Promise.all([
      db.select({ name: users.name, email: users.email }).from(users),
      db.select({ name: people.name, email: people.email }).from(people),
    ]);
    const to = resolveAssigneeEmail(opts.assignee, staff, userRows, roster);
    if (!to || to === opts.actorEmail.toLowerCase()) return; // unknown assignee or self-assign
    const url = appUrl();
    await sendEmail(
      [to],
      `${opts.externalId}: assigned "${opts.taskTitle}"`,
      wrap(`${esc(opts.actorName)} assigned you <b>${esc(opts.taskTitle)}</b> on <b>${esc(opts.externalId)}</b>.
        ${url && (opts.instrumentId || opts.assetId)
          ? `<div style="margin-top:10px;"><a href="${url}${opts.instrumentId ? `/instruments/${opts.instrumentId}` : `/assets/${opts.assetId}`}">Open ${esc(opts.externalId)}</a></div>`
          : ""}`),
    );
  } catch (e) {
    console.error("[notify] task-assigned email failed:", (e as Error).message);
  }
}

export async function notifySystemAssigned(opts: {
  // `label` is composed from the system's assets and can be empty on a system
  // that has none yet, so the ID carries the subject on its own.
  actorEmail: string; actorName: string; lead: string; instrumentId: number; externalId: string; label: string;
}) {
  try {
    const staff = parseList(process.env.STAFF_EMAILS);
    const [userRows, roster] = await Promise.all([
      db.select({ name: users.name, email: users.email }).from(users),
      db.select({ name: people.name, email: people.email }).from(people),
    ]);
    const to = resolveAssigneeEmail(opts.lead, staff, userRows, roster);
    if (!to || to === opts.actorEmail.toLowerCase()) return;
    const url = appUrl();
    await sendEmail(
      [to],
      `${opts.externalId}: you're the lead`,
      wrap(`${esc(opts.actorName)} made you the lead on <b>${esc(opts.externalId)}${opts.label ? ` - ${esc(opts.label)}` : ""}</b>.
        ${url ? `<div style="margin-top:10px;"><a href="${url}/instruments/${opts.instrumentId}">Open ${esc(opts.externalId)}</a></div>` : ""}`),
    );
  } catch (e) {
    console.error("[notify] system-assigned email failed:", (e as Error).message);
  }
}

export async function notifyDiscussion(opts: {
  actorEmail: string; actorName: string; actorIsClient: boolean;
  body: string; instrumentId: number | null; label: string; // label: externalId or "General"
  // Emails quote the post, so only people who can see the thread may be
  // notified: staff, plus the organizations the system is shared with.
  allowedEmails?: string[] | null;
}) {
  try {
    const staff = parseList(process.env.STAFF_EMAILS);
    const [userRows, roster] = await Promise.all([
      db.select({ name: users.name, email: users.email }).from(users),
      db.select({ name: people.name, email: people.email }).from(people),
    ]);
    const actor = opts.actorEmail.toLowerCase();
    const to = new Set<string>();
    // Mentioned people get pinged directly.
    for (const name of parseMentions(opts.body, roster.map((p) => p.name))) {
      const email = resolveAssigneeEmail(name, staff, userRows, roster);
      if (email && email !== actor) to.add(email);
    }
    // A client post always reaches all staff - their questions must never be missed.
    if (opts.actorIsClient) for (const e of staff) if (e !== actor) to.add(e);
    if (opts.allowedEmails) {
      const allowed = new Set(opts.allowedEmails.map((e) => e.toLowerCase()));
      for (const e of [...to]) if (!allowed.has(e)) to.delete(e);
    }
    if (!to.size) return;
    const url = appUrl();
    const link = opts.instrumentId != null ? `${url}/instruments/${opts.instrumentId}` : `${url}/discussions`;
    await sendEmail(
      [...to],
      `${opts.label}: ${opts.actorName} posted in discussion`,
      wrap(`<b>${esc(opts.actorName)}</b> on <b>${esc(opts.label)}</b>:
        <div style="border-left:3px solid #E2E8F0;padding:6px 10px;margin:8px 0;white-space:pre-wrap;">${esc(opts.body)}</div>
        ${url ? `<a href="${link}">Reply in the portal</a>` : ""}`),
    );
  } catch (e) {
    console.error("[notify] discussion email failed:", (e as Error).message);
  }
}

export async function notifyAccessRequest(opts: {
  // Recipients are computed by the caller: staff plus the owning org's
  // sign-in emails - the people who can actually decide.
  to: string[]; actorName: string; orgName: string;
  externalId: string; instrumentId: number; assetDesc: string; message: string;
}) {
  try {
    if (!opts.to.length) return;
    const url = appUrl();
    await sendEmail(
      opts.to,
      `${opts.externalId}: access request from ${opts.orgName || opts.actorName}`,
      wrap(`<b>${esc(opts.actorName)}</b>${opts.orgName ? ` (${esc(opts.orgName)})` : ""} matched <b>${esc(opts.assetDesc)}</b> by serial number and is asking for access to <b>${esc(opts.externalId)}</b>.
        ${opts.message ? `<div style="border-left:3px solid #E2E8F0;padding:6px 10px;margin:8px 0;white-space:pre-wrap;">${esc(opts.message)}</div>` : ""}
        ${url ? `<div style="margin-top:10px;"><a href="${url}/instruments/${opts.instrumentId}">Approve or deny on ${esc(opts.externalId)}</a></div>` : ""}`),
    );
  } catch (e) {
    console.error("[notify] access-request email failed:", (e as Error).message);
  }
}

export async function notifyGasEmpty(opts: { actorEmail: string; actorName: string; gas: string; instrumentId: number; externalId: string }) {
  try {
    const to = parseList(process.env.STAFF_EMAILS).filter((e) => e !== opts.actorEmail.toLowerCase());
    if (!to.length) return;
    const url = appUrl();
    await sendEmail(
      to,
      `${opts.externalId}: ${opts.gas} is EMPTY`,
      wrap(`${esc(opts.actorName)} marked <b>${esc(opts.gas)}</b> empty on <b>${esc(opts.externalId)}</b>.
        ${url ? `<div style="margin-top:10px;"><a href="${url}/instruments/${opts.instrumentId}">Open ${esc(opts.externalId)}</a></div>` : ""}`),
    );
  } catch (e) {
    console.error("[notify] gas-empty email failed:", (e as Error).message);
  }
}
