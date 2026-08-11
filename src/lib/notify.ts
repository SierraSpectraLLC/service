// Event notifications: an inbox row per recipient, then email via Resend.
// Every send is wrapped so a mail failure can never fail the action that
// triggered it. Magic links deliberately don't come through here - sign-in
// mail is auth infrastructure (src/auth.ts), not a notification anyone may
// opt out of or needs a record of.
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { users, people, notifications, notificationPrefs } from "@/db/schema";
import { houseEmails } from "@/lib/house";
import { sendEmail } from "@/lib/email";
import { emailAllowed, type NotifyKind } from "@/lib/inbox";
import { getBrand } from "@/lib/brand";
import { appUrl } from "@/lib/appUrl";

export type Person = { name: string; email: string };

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");


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

/**
 * The one door every notification leaves through. Inbox rows are written
 * FIRST - the in-app record must exist even if the mailer is down or the
 * recipient opted out of email - then the email goes to whoever hasn't
 * turned that kind off. Callers stay inside their own try/catch, so a dead
 * notifications table (pre-sync deploy race) degrades exactly like a dead
 * mailer always has: logged, action unaffected.
 */
async function deliver(opts: {
  to: string[]; kind: NotifyKind; title: string;
  href: string;      // in-app path ("/instruments/12"), "" when there's nowhere to go
  subject: string; html: string;
}) {
  const emails = [...new Set(opts.to.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (!emails.length) return;
  await db.insert(notifications).values(emails.map((email) => ({
    email, kind: opts.kind, title: opts.title.slice(0, 200), href: opts.href,
  })));
  const prefRows = await db.select().from(notificationPrefs).where(inArray(notificationPrefs.email, emails));
  const wantEmail = emails.filter((e) => emailAllowed(prefRows.filter((p) => p.email === e), opts.kind));
  if (wantEmail.length) await sendEmail(wantEmail, opts.subject, opts.html);
}

// System notifications are sent by the platform, so they carry its name rather
// than any one service company's - see lib/brand.ts.
const wrap = async (body: string) => `
  <div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#172A4A;">
    <div style="font-weight:bold;letter-spacing:0.3px;margin-bottom:10px;">${esc((await getBrand()).name).toUpperCase()}</div>
    ${body}
  </div>`;

export async function notifyTaskAssigned(opts: {
  actorEmail: string; actorName: string; assignee: string;
  // A task lives on a system, on a standalone asset, or both - the link points
  // at whichever page owns it.
  taskTitle: string; instrumentId?: number; assetId?: number; externalId: string;
}) {
  try {
    const staff = await houseEmails();
    const [userRows, roster] = await Promise.all([
      db.select({ name: users.name, email: users.email }).from(users),
      db.select({ name: people.name, email: people.email }).from(people),
    ]);
    const to = resolveAssigneeEmail(opts.assignee, staff, userRows, roster);
    if (!to || to === opts.actorEmail.toLowerCase()) return; // unknown assignee or self-assign
    const url = appUrl();
    const href = opts.instrumentId ? `/instruments/${opts.instrumentId}` : opts.assetId ? `/assets/${opts.assetId}` : "";
    await deliver({
      to: [to], kind: "task_assigned", href,
      title: `${opts.actorName} assigned you "${opts.taskTitle}" on ${opts.externalId}`,
      subject: `${opts.externalId}: assigned "${opts.taskTitle}"`,
      html: await wrap(`${esc(opts.actorName)} assigned you <b>${esc(opts.taskTitle)}</b> on <b>${esc(opts.externalId)}</b>.
        ${url && href ? `<div style="margin-top:10px;"><a href="${url}${href}">Open ${esc(opts.externalId)}</a></div>` : ""}`),
    });
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
    const staff = await houseEmails();
    const [userRows, roster] = await Promise.all([
      db.select({ name: users.name, email: users.email }).from(users),
      db.select({ name: people.name, email: people.email }).from(people),
    ]);
    const to = resolveAssigneeEmail(opts.lead, staff, userRows, roster);
    if (!to || to === opts.actorEmail.toLowerCase()) return;
    const url = appUrl();
    await deliver({
      to: [to], kind: "system_assigned", href: `/instruments/${opts.instrumentId}`,
      title: `${opts.actorName} made you the lead on ${opts.externalId}`,
      subject: `${opts.externalId}: you're the lead`,
      html: await wrap(`${esc(opts.actorName)} made you the lead on <b>${esc(opts.externalId)}${opts.label ? ` - ${esc(opts.label)}` : ""}</b>.
        ${url ? `<div style="margin-top:10px;"><a href="${url}/instruments/${opts.instrumentId}">Open ${esc(opts.externalId)}</a></div>` : ""}`),
    });
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
    const staff = await houseEmails();
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
    const href = opts.instrumentId != null ? `/instruments/${opts.instrumentId}` : "/discussions";
    await deliver({
      to: [...to], kind: "discussion", href,
      title: `${opts.actorName} posted in discussion on ${opts.label}`,
      subject: `${opts.label}: ${opts.actorName} posted in discussion`,
      html: await wrap(`<b>${esc(opts.actorName)}</b> on <b>${esc(opts.label)}</b>:
        <div style="border-left:3px solid #E2E8F0;padding:6px 10px;margin:8px 0;white-space:pre-wrap;">${esc(opts.body)}</div>
        ${url ? `<a href="${url}${href}">Reply in the portal</a>` : ""}`),
    });
  } catch (e) {
    console.error("[notify] discussion email failed:", (e as Error).message);
  }
}

export async function notifyAccessRequest(opts: {
  // Recipients are computed by the caller: staff plus the owning org's
  // sign-in emails - the people who can actually decide.
  to: string[]; actorName: string; orgName: string;
  externalId: string; instrumentId: number; assetDesc: string; message: string;
  // A claim asserts ownership, so it reads differently and is decided only by
  // the platform operator.
  kind?: string;
}) {
  try {
    if (!opts.to.length) return;
    const url = appUrl();
    const claim = opts.kind === "claim";
    const subject = claim
      ? `${opts.externalId}: ownership claim from ${opts.orgName || opts.actorName}`
      : `${opts.externalId}: access request from ${opts.orgName || opts.actorName}`;
    await deliver({
      to: opts.to, kind: "access_request", href: `/instruments/${opts.instrumentId}`,
      title: subject, subject,
      html: await wrap(`<b>${esc(opts.actorName)}</b>${opts.orgName ? ` (${esc(opts.orgName)})` : ""} matched <b>${esc(opts.assetDesc)}</b> by serial number and ${claim ? `says they <b>own</b>` : `is asking for access to`} <b>${esc(opts.externalId)}</b>.
        ${opts.message ? `<div style="border-left:3px solid #E2E8F0;padding:6px 10px;margin:8px 0;white-space:pre-wrap;">${esc(opts.message)}</div>` : ""}
        ${url ? `<div style="margin-top:10px;"><a href="${url}/instruments/${opts.instrumentId}">Approve or deny on ${esc(opts.externalId)}</a></div>` : ""}`),
    });
  } catch (e) {
    console.error("[notify] access-request email failed:", (e as Error).message);
  }
}

/**
 * Somebody wrote @Name in a task or checklist note. Same name resolution as
 * discussion mentions (roster, then users, then a staff-email prefix), and the
 * same visibility discipline: the note's text travels in the notification, so
 * only people who could open the task may be pinged by it - the caller passes
 * that audience in.
 */
export async function notifyMention(opts: {
  actorEmail: string; actorName: string; body: string;
  where: string;               // "task 'Replace seals' on SS-1042"
  href: string;                // in-app path to the page that holds the note
  allowedEmails: string[] | null; // null = house-only context, no restriction
}) {
  try {
    const staff = await houseEmails();
    const [userRows, roster] = await Promise.all([
      db.select({ name: users.name, email: users.email }).from(users),
      db.select({ name: people.name, email: people.email }).from(people),
    ]);
    const actor = opts.actorEmail.toLowerCase();
    const to = new Set<string>();
    for (const name of parseMentions(opts.body, roster.map((p) => p.name))) {
      const email = resolveAssigneeEmail(name, staff, userRows, roster);
      if (email && email !== actor) to.add(email);
    }
    if (opts.allowedEmails) {
      const allowed = new Set(opts.allowedEmails.map((e) => e.toLowerCase()));
      for (const e of [...to]) if (!allowed.has(e)) to.delete(e);
    }
    if (!to.size) return;
    const url = appUrl();
    await deliver({
      to: [...to], kind: "mention", href: opts.href,
      title: `${opts.actorName} mentioned you on ${opts.where}`,
      subject: `You were mentioned on ${opts.where}`,
      html: await wrap(`<b>${esc(opts.actorName)}</b> mentioned you on ${esc(opts.where)}:
        <div style="border-left:3px solid #E2E8F0;padding:6px 10px;margin:8px 0;white-space:pre-wrap;">${esc(opts.body)}</div>
        ${url ? `<a href="${url}${opts.href}">Open it</a>` : ""}`),
    });
  } catch (e) {
    console.error("[notify] mention email failed:", (e as Error).message);
  }
}

/**
 * A system has landed in your queue. This is the one notification that carries
 * an expectation with it, so it leads with the reason: what the sender is
 * waiting on is the only thing the recipient actually needs.
 */
export async function notifyQueueKick(opts: {
  to: string[]; externalId: string; instrumentId: number;
  fromName: string; toName: string; reason: string; stages: string[];
}) {
  try {
    const url = appUrl();
    const stage = opts.stages.length ? opts.stages[opts.stages.length - 1] : "";
    await deliver({
      to: opts.to, kind: "queue", href: `/instruments/${opts.instrumentId}`,
      title: `${opts.externalId} is in ${opts.toName}'s queue: ${opts.reason}`,
      subject: `${opts.externalId}: over to you - ${opts.reason}`,
      html: await wrap(`<b>${esc(opts.fromName)}</b> moved <b>${esc(opts.externalId)}</b> into
        <b>${esc(opts.toName)}</b>'s queue${stage ? ` (currently ${esc(stage)})` : ""}.
        <div style="border-left:3px solid #E2E8F0;padding:6px 10px;margin:8px 0;white-space:pre-wrap;">${esc(opts.reason)}</div>
        <div style="margin-top:8px;">Nothing is blocked at ${esc(opts.fromName)}'s end. Move it back whenever
        it's theirs again - the record and the history stay exactly as they are.</div>
        ${url ? `<div style="margin-top:10px;"><a href="${url}/instruments/${opts.instrumentId}">Open ${esc(opts.externalId)}</a></div>` : ""}`),
    });
  } catch (e) {
    console.error("[notify] queue email failed:", (e as Error).message);
  }
}

/**
 * A system changed hands. Both sides hear about it in one send - the new owner
 * because they now own it, the outgoing owner because their access just changed
 * and they should know a record was kept for them.
 */
export async function notifyHandoff(opts: {
  to: string[]; externalId: string; instrumentId: number; fromName: string; toName: string; note: string;
}) {
  try {
    const url = appUrl();
    await deliver({
      to: opts.to, kind: "handoff", href: `/instruments/${opts.instrumentId}`,
      title: `${opts.externalId} changed hands: ${opts.fromName} → ${opts.toName}`,
      subject: `${opts.externalId}: now owned by ${opts.toName}`,
      html: await wrap(`<b>${esc(opts.externalId)}</b> has been handed from <b>${esc(opts.fromName)}</b> to <b>${esc(opts.toName)}</b>.
        ${opts.note ? `<div style="border-left:3px solid #E2E8F0;padding:6px 10px;margin:8px 0;white-space:pre-wrap;">${esc(opts.note)}</div>` : ""}
        <div style="margin-top:8px;">The full service history transfers with it. ${esc(opts.fromName)} keeps a frozen
        record of their period of ownership.</div>
        ${url ? `<div style="margin-top:10px;"><a href="${url}/instruments/${opts.instrumentId}">Open ${esc(opts.externalId)}</a></div>` : ""}`),
    });
  } catch (e) {
    console.error("[notify] handoff email failed:", (e as Error).message);
  }
}

// Invitations stay plain email, not deliver(): the recipient has never signed
// in, so an inbox row would greet them with old news and an opt-out would be
// self-defeating - the email IS the invitation.
export async function notifyInvite(opts: { to: string; inviterName: string; orgName: string }) {
  try {
    const brand = (await getBrand()).name;
    const url = appUrl();
    await sendEmail(
      [opts.to],
      `${opts.inviterName} invited you to ${brand}`,
      await wrap(`${esc(opts.inviterName)} added you to <b>${esc(opts.orgName)}</b>'s workspace on ${esc(brand)}.
        ${url ? `<div style="margin-top:10px;"><a href="${url}/login">Sign in with this email address</a> - no password, a sign-in link is emailed to you.</div>` : ""}`),
    );
  } catch (e) {
    console.error("[notify] invite email failed:", (e as Error).message);
  }
}

export async function notifyGasEmpty(opts: { actorEmail: string; actorName: string; gas: string; instrumentId: number; externalId: string }) {
  try {
    const to = (await houseEmails()).filter((e) => e !== opts.actorEmail.toLowerCase());
    if (!to.length) return;
    const url = appUrl();
    await deliver({
      to, kind: "gas_empty", href: `/instruments/${opts.instrumentId}`,
      title: `${opts.actorName} marked ${opts.gas} empty on ${opts.externalId}`,
      subject: `${opts.externalId}: ${opts.gas} is EMPTY`,
      html: await wrap(`${esc(opts.actorName)} marked <b>${esc(opts.gas)}</b> empty on <b>${esc(opts.externalId)}</b>.
        ${url ? `<div style="margin-top:10px;"><a href="${url}/instruments/${opts.instrumentId}">Open ${esc(opts.externalId)}</a></div>` : ""}`),
    });
  } catch (e) {
    console.error("[notify] gas-empty email failed:", (e as Error).message);
  }
}
