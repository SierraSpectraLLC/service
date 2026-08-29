// Event notifications: an inbox row per recipient, then email via Resend.
// Every send is wrapped so a mail failure can never fail the action that
// triggered it. Magic links deliberately don't come through here - sign-in
// mail is auth infrastructure (src/auth.ts), not a notification anyone may
// opt out of or needs a record of.
import { eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { instruments, users, notifications, notificationPrefs } from "@/db/schema";
import { houseEmails } from "@/lib/house";
import { sendEmail } from "@/lib/email";
import { emailAllowed, holdFor, type NotifyKind } from "@/lib/inbox";
import { queueEmail } from "@/lib/outboxData";
import { getBrand } from "@/lib/brand";
import { appUrl } from "@/lib/appUrl";
import { namedLogins } from "@/lib/directory";
import { esc, btn, quote, mutedLine } from "@/lib/emailTheme";
import { wrapNotification } from "@/lib/notifyShell";
import { STATUS_LABEL, sinceWords, type PersonUsage } from "@/lib/loginLog";

export type Person = { name: string; email: string };


/**
 * Assignees/mentions are freeform names ("Joe", "Thomas", "Chris Ma").
 * Resolve to an email by (1) the directory of logins, (2) exact users.name
 * match, then (3) a staff email whose local part starts with the name
 * (joe -> joe.vincent96@...). Null when nothing matches - the caller skips the
 * notification rather than guessing.
 */
export function resolveAssigneeEmail(
  name: string,
  staffEmails: string[],
  userRows: { name: string | null; email: string }[],
  directory: Person[] = [],
): string | null {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  const inDirectory = directory.find((p) => p.name.trim().toLowerCase() === n && p.email.trim());
  if (inDirectory) return inDirectory.email.trim().toLowerCase();
  const byName = userRows.find((u) => (u.name || "").trim().toLowerCase() === n);
  if (byName) return byName.email.toLowerCase();
  return staffEmails.find((e) => e.split("@")[0].startsWith(n)) ?? null;
}

/**
 * Which directory names does a post @mention? A name matches on its full form
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
  subject: string;
  /** Body HTML only - deliver dresses it in the shared shell, with the inbox
   * title as the preview line, so no notification can forget the envelope. */
  body: string;
  /**
   * The three facts a HELD email is grouped and worded by when several of them
   * arrive together: who did it, what to, and the bare thing itself. Only the
   * kinds that wait need them (lib/inbox.holdFor); everything else sends at
   * once and never reads them. See lib/outbox.
   */
  actor?: string;
  context?: string;
  item?: string;
}) {
  const emails = [...new Set(opts.to.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (!emails.length) return;
  /* THE RECORD IS NEVER HELD. Whatever the email does, the inbox row is
     written now: the bell lights up on the fifth assignment as it did on the
     first, and what waits is the interruption alone. */
  await db.insert(notifications).values(emails.map((email) => ({
    email, kind: opts.kind, title: opts.title.slice(0, 200), href: opts.href,
  })));
  const prefRows = await db.select().from(notificationPrefs).where(inArray(notificationPrefs.email, emails));
  const wantEmail = emails.filter((e) => emailAllowed(prefRows.filter((p) => p.email === e), opts.kind));
  if (!wantEmail.length) return;

  // A bursty kind goes to the waiting room; everything else leaves now.
  if (holdFor(opts.kind)) {
    await queueEmail(wantEmail.map((email) => ({
      email, kind: opts.kind, title: opts.title.slice(0, 200), href: opts.href,
      subject: opts.subject, body: opts.body,
      actor: opts.actor ?? "", context: opts.context ?? "", item: opts.item ?? "",
    })));
    return;
  }
  await sendEmail(wantEmail, opts.subject, await wrap(opts.body, { preheader: opts.title }));
}

/* The envelope every notification leaves in, shared with the outbox so a held
   email and an immediate one are the same email in every respect but timing. */
const wrap = wrapNotification;

export async function notifyTaskAssigned(opts: {
  actorEmail: string; actorName: string; assignee: string;
  // A task lives on a system, on a standalone asset, or both - the link points
  // at whichever page owns it.
  taskTitle: string; instrumentId?: number; assetId?: number; externalId: string;
  /** Set when the assignment IS a work order - the link goes to the job, not the system. */
  workOrderId?: number;
}) {
  try {
    const staff = await houseEmails();
    const [userRows, directory] = await Promise.all([
      db.select({ name: users.name, email: users.email }).from(users),
      namedLogins(),
    ]);
    const to = resolveAssigneeEmail(opts.assignee, staff, userRows, directory);
    if (!to || to === opts.actorEmail.toLowerCase()) return; // unknown assignee or self-assign
    const url = appUrl();
    const href = opts.workOrderId ? `/work/${opts.workOrderId}`
      : opts.instrumentId ? `/instruments/${opts.instrumentId}` : opts.assetId ? `/assets/${opts.assetId}` : "";
    await deliver({
      to: [to], kind: "task_assigned", href,
      title: `${opts.actorName} assigned you "${opts.taskTitle}" on ${opts.externalId}`,
      subject: `${opts.externalId}: assigned "${opts.taskTitle}"`,
      // What a batch of these is grouped by, and what each line of one says.
      actor: opts.actorName, context: opts.externalId, item: opts.taskTitle,
      body: `${esc(opts.actorName)} assigned you <b>${esc(opts.taskTitle)}</b> on <b>${esc(opts.externalId)}</b>.
        ${url && href ? btn(`${url}${href}`, `Open ${opts.externalId}`) : ""}`,
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
    const [userRows, directory] = await Promise.all([
      db.select({ name: users.name, email: users.email }).from(users),
      namedLogins(),
    ]);
    const to = resolveAssigneeEmail(opts.lead, staff, userRows, directory);
    if (!to || to === opts.actorEmail.toLowerCase()) return;
    const url = appUrl();
    await deliver({
      to: [to], kind: "system_assigned", href: `/instruments/${opts.instrumentId}`,
      title: `${opts.actorName} made you the lead on ${opts.externalId}`,
      subject: `${opts.externalId}: you're the lead`,
      body: `${esc(opts.actorName)} made you the lead on <b>${esc(opts.externalId)}${opts.label ? ` - ${esc(opts.label)}` : ""}</b>.
        ${url ? btn(`${url}/instruments/${opts.instrumentId}`, `Open ${opts.externalId}`) : ""}`,
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
    const [userRows, directory] = await Promise.all([
      db.select({ name: users.name, email: users.email }).from(users),
      namedLogins(),
    ]);
    const actor = opts.actorEmail.toLowerCase();
    const to = new Set<string>();
    // Mentioned people get pinged directly.
    for (const name of parseMentions(opts.body, directory.map((p) => p.name))) {
      const email = resolveAssigneeEmail(name, staff, userRows, directory);
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
      body: `<b>${esc(opts.actorName)}</b> on <b>${esc(opts.label)}</b>:
        ${quote(opts.body)}
        ${url ? btn(`${url}${href}`, "Reply in the portal") : ""}`,
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
      body: `<b>${esc(opts.actorName)}</b>${opts.orgName ? ` (${esc(opts.orgName)})` : ""} matched <b>${esc(opts.assetDesc)}</b> by serial number and ${claim ? `says they <b>own</b>` : `is asking for access to`} <b>${esc(opts.externalId)}</b>.
        ${opts.message ? quote(opts.message) : ""}
        ${url ? btn(`${url}/instruments/${opts.instrumentId}`, `Approve or deny on ${opts.externalId}`) : ""}`,
    });
  } catch (e) {
    console.error("[notify] access-request email failed:", (e as Error).message);
  }
}

/**
 * Somebody wrote @Name in a task or checklist note. Same name resolution as
 * discussion mentions (directory, then users, then a staff-email prefix), and the
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
    const [userRows, directory] = await Promise.all([
      db.select({ name: users.name, email: users.email }).from(users),
      namedLogins(),
    ]);
    const actor = opts.actorEmail.toLowerCase();
    const to = new Set<string>();
    for (const name of parseMentions(opts.body, directory.map((p) => p.name))) {
      const email = resolveAssigneeEmail(name, staff, userRows, directory);
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
      body: `<b>${esc(opts.actorName)}</b> mentioned you on ${esc(opts.where)}:
        ${quote(opts.body)}
        ${url ? btn(`${url}${opts.href}`, "Open it") : ""}`,
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
/**
 * A client raised a problem on one of their systems.
 *
 * Sent to whoever services it, not to the client - they know; they just pressed
 * the button. Severity leads the subject line because "down" and "a question"
 * deserve different reactions from somebody reading on a phone.
 */
export async function notifyIssueRaised(opts: {
  to: string[]; externalId: string; instrumentId: number; orgName: string;
  severity: string; summary: string; details: string; reporter: string; files: number;
}) {
  try {
    const url = appUrl();
    const urgent = opts.severity === "Down";
    await deliver({
      to: opts.to, kind: "issue", href: `/instruments/${opts.instrumentId}`,
      title: `${opts.orgName} reported ${opts.severity.toLowerCase()} on ${opts.externalId}: ${opts.summary}`,
      subject: `${urgent ? "DOWN" : opts.severity} - ${opts.externalId}: ${opts.summary}`,
      body: `<b>${esc(opts.orgName)}</b> reported a problem with
        <b>${esc(opts.externalId)}</b>${urgent ? " and says it is <b>down</b>" : ""}.
        <div style="margin-top:8px;"><b>${esc(opts.summary)}</b></div>
        ${opts.details ? quote(opts.details) : ""}
        ${mutedLine(`Raised by ${esc(opts.reporter)}${opts.files ? `, with ${opts.files} file${opts.files === 1 ? "" : "s"} attached` : ""}.
        The system is marked as needing maintenance and is in your queue.`)}
        ${url ? btn(`${url}/instruments/${opts.instrumentId}`, `Open ${opts.externalId}`) : ""}`,
    });
  } catch (e) {
    console.error("[notify] issue email failed:", (e as Error).message);
  }
}

/**
 * A client asking for maintenance. Quieter than a fault by design - nothing is
 * broken - but it carries the two facts that decide what to do: the horizon they
 * asked for, and what the calendar already says.
 */
export async function notifyPmRequested(opts: {
  to: string[]; externalId: string; instrumentId: number; orgName: string;
  windowLabel: string; note: string; calendar: string; requester: string; dueDate: string;
}) {
  try {
    const url = appUrl();
    await deliver({
      to: opts.to, kind: "pm_request", href: `/instruments/${opts.instrumentId}`,
      title: `${opts.orgName} asked for maintenance on ${opts.externalId} - ${opts.windowLabel.toLowerCase()}`,
      subject: `Maintenance requested - ${opts.externalId} (${opts.windowLabel.toLowerCase()})`,
      body: `<b>${esc(opts.orgName)}</b> asked for maintenance on
        <b>${esc(opts.externalId)}</b>, ${esc(opts.windowLabel.toLowerCase())}.
        ${opts.note ? quote(opts.note) : ""}
        ${mutedLine(`Requested by ${esc(opts.requester)}. There's a task on the system dated
        ${esc(opts.dueDate)}, and it's in your queue.${opts.calendar ? ` ${esc(opts.calendar)}` : ""}`)}
        ${url ? btn(`${url}/instruments/${opts.instrumentId}`, `Open ${opts.externalId}`) : ""}`,
    });
  } catch (e) {
    console.error("[notify] pm request email failed:", (e as Error).message);
  }
}

/**
 * Tell an organization what its systems need bought.
 *
 * The only notification in this app that asks the CLIENT to do the buying -
 * for the clients who run their own vendor account, where our job is to say
 * precisely what is needed and theirs is to order it. The list is the message,
 * so it is in the mail body rather than behind a link somebody has to open.
 */
export async function notifyPartsRequested(opts: {
  to: string[]; orgName: string; actorName: string; note: string;
  parts: { name: string; partNumber: string; qty: number; instrumentId: number | null; assetId: number | null }[];
}) {
  try {
    const url = appUrl();
    const first = opts.parts[0];
    const href = first?.instrumentId !== null && first?.instrumentId !== undefined
      ? `/instruments/${first.instrumentId}` : "/assets";
    const n = opts.parts.length;
    const list = opts.parts.map((p) =>
      `<li>${esc(p.name)}${p.partNumber ? ` - <span style="font-family:monospace">${esc(p.partNumber)}</span>` : ""}`
      + `${p.qty > 1 ? ` x${p.qty}` : ""}</li>`).join("");
    await deliver({
      to: opts.to, kind: "parts_request", href,
      title: `${opts.actorName} asked ${opts.orgName} to order ${n} part${n === 1 ? "" : "s"}`,
      subject: `Parts to order - ${n} item${n === 1 ? "" : "s"}`,
      body: `<b>${esc(opts.actorName)}</b> has asked ${esc(opts.orgName)} to order
        ${n} part${n === 1 ? "" : "s"} for your systems.
        <ul style="margin:8px 0;padding-left:18px;">${list}</ul>
        ${opts.note ? quote(opts.note) : ""}
        ${mutedLine(`They stay marked <b>Needed</b> on the record until they arrive.`)}
        ${url ? btn(`${url}${href}`, "Open the record") : ""}`,
    });
  } catch (e) {
    console.error("[notify] parts request email failed:", (e as Error).message);
  }
}

/**
 * Somebody wrote to you directly.
 *
 * The body is quoted, because a direct message is short and making somebody
 * open a tab to read one line is how a notification becomes noise. Everyone
 * addressed can already see it - they are in the thread.
 */
/**
 * Files arrived through a drop link. Sent to whoever made the link - an
 * anonymous write into the store that nobody is told about is how a bearer
 * token quietly becomes a liability.
 */
export async function notifyDropReceived(opts: {
  to: string; label: string; count: number; names: string[];
}) {
  try {
    const what = opts.names.slice(0, 3).join(", ") + (opts.count > 3 ? ` +${opts.count - 3} more` : "");
    await deliver({
      to: [opts.to], kind: "drop", href: "/documents",
      title: `${opts.count} file${opts.count === 1 ? "" : "s"} arrived via "${opts.label}": ${what}`,
      subject: `Files arrived through your drop link`,
      body: `<b>${esc(String(opts.count))} file${opts.count === 1 ? "" : "s"}</b> arrived through
        your drop link <b>${esc(opts.label)}</b>:<br>${esc(what)}
        ${appUrl() ? btn(`${appUrl()}/documents`, "Open Files") : ""}`,
    });
  } catch (e) {
    console.error("notifyDropReceived:", e);
  }
}

export async function notifyMessage(opts: {
  to: string[]; threadId: number; fromName: string; body: string;
  title: string; memberCount: number;
}) {
  try {
    if (!opts.to.length) return;
    const url = appUrl();
    const href = `/messages/${opts.threadId}`;
    const where = opts.title.trim()
      ? ` in ${opts.title.trim()}`
      : opts.memberCount > 2 ? " in a group" : "";
    const preview = opts.body.length > 300 ? `${opts.body.slice(0, 300)}...` : opts.body;
    await deliver({
      to: opts.to, kind: "message", href,
      title: `${opts.fromName}${where}: ${opts.body.slice(0, 120)}`,
      subject: `${opts.fromName} messaged you${where}`,
      body: `<b>${esc(opts.fromName)}</b> wrote${esc(where)}:
        ${quote(preview)}
        ${url ? btn(`${url}${href}`, "Reply") : ""}`,
    });
  } catch (e) {
    console.error("[notify] message email failed:", (e as Error).message);
  }
}

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
      body: `<b>${esc(opts.fromName)}</b> moved <b>${esc(opts.externalId)}</b> into
        <b>${esc(opts.toName)}</b>'s queue${stage ? ` (currently ${esc(stage)})` : ""}.
        ${quote(opts.reason)}
        ${mutedLine(`Nothing is blocked at ${esc(opts.fromName)}'s end. Move it back whenever
        it's theirs again - the record and the history stay exactly as they are.`)}
        ${url ? btn(`${url}/instruments/${opts.instrumentId}`, `Open ${opts.externalId}`) : ""}`,
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
      body: `<b>${esc(opts.externalId)}</b> has been handed from <b>${esc(opts.fromName)}</b> to <b>${esc(opts.toName)}</b>.
        ${opts.note ? quote(opts.note) : ""}
        ${mutedLine(`The full service history transfers with it. ${esc(opts.fromName)} keeps a frozen
        record of their period of ownership.`)}
        ${url ? btn(`${url}/instruments/${opts.instrumentId}`, `Open ${opts.externalId}`) : ""}`,
    });
  } catch (e) {
    console.error("[notify] handoff email failed:", (e as Error).message);
  }
}

// Invitations stay plain email, not deliver(): the recipient has never signed
// in, so an inbox row would greet them with old news and an opt-out would be
// self-defeating - the email IS the invitation.
export async function notifyInvite(opts: {
  to: string; inviterName: string; orgName: string;
  /**
   * Whether a temporary password was set for them at the same time, WITHOUT
   * saying what it is. Used where the password is being read down a phone
   * instead - see mintTempPassword.
   */
  tempPassword?: boolean;
  /**
   * The temporary password in the clear, to be printed in this email.
   *
   * This is a live credential in an inbox, and the trade is deliberate: a
   * resent invitation exists because somebody could not get in, and an
   * operator resending one wants the person working rather than waiting for a
   * phone call. It is chosen per send by the caller (actions.resendInvite),
   * never defaulted on, and it EXPIRES - which is what keeps a mailbox from
   * being a permanent key. Where the mail channel itself is the thing that is
   * broken, `tempPassword` above is still the right field.
   */
  tempPasswordPlain?: string;
  /** The day it stops working, printed beside it so the loan has a visible end. */
  tempExpiresOn?: string;
}): Promise<boolean> {
  try {
    const brand = (await getBrand()).name;
    const url = appUrl();
    const how = opts.tempPasswordPlain
      ? "Use this email address and the temporary password below. You can set your own once you are in."
      : opts.tempPassword
        ? "Use this email address. A temporary password has been set for you - whoever added you will pass it on. You can set your own once you are in."
        : "Use this email address - no password, a sign-in code is emailed to you.";
    const creds = opts.tempPasswordPlain
      ? `<div style="margin:14px 0;padding:12px 14px;border-radius:8px;background:#FAF0DC;border:1px solid #E4CFA1">
          <div style="font-size:12px;color:#7A5B12;font-weight:700">Your temporary password</div>
          <div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:18px;letter-spacing:0.02em;margin:6px 0">${esc(opts.tempPasswordPlain)}</div>
          <div style="font-size:12px;color:#7A5B12">${
            opts.tempExpiresOn
              ? `Works until ${esc(opts.tempExpiresOn)}, then sign-in goes back to emailed codes.`
              : "Temporary - set your own password once you are in."
          }</div>
        </div>`
      : "";
    await sendEmail(
      [opts.to],
      `${opts.inviterName} invited you to ${brand}`,
      await wrap(`${esc(opts.inviterName)} added you to <b>${esc(opts.orgName)}</b>'s workspace on ${esc(brand)}.
        ${url ? `${btn(`${url}/login`, "Sign in")}
        ${mutedLine(how)}` : ""}
        ${creds}`,
      { preheader: `${opts.inviterName} added you to ${opts.orgName}'s workspace`, prefsFooter: false }),
    );
    return true;
  } catch (e) {
    console.error("[notify] invite email failed:", (e as Error).message);
    /* Reported rather than only logged. Every other notification here is a
       courtesy on top of something the app already recorded, so swallowing a
       failure costs an FYI. An INVITATION is the thing itself - and a resend
       carrying a password has already invalidated the one they had, so a
       silent failure leaves somebody strictly worse off than before it ran.
       Callers that treat it as a courtesy can go on ignoring this. */
    return false;
  }
}

/**
 * Somebody recorded a unit whose model the catalog has never heard of.
 *
 * Deliberately NOT an error anywhere - the unit in front of somebody always
 * gets recorded (the same 2am rule parts live by). This is the other half of
 * that bargain: the house hears about it while it is fresh, and the catalog
 * page holds the review queue where the name is accepted or corrected.
 */
export async function notifyModelProposed(opts: {
  actorEmail: string; actorName: string; kind: string; model: string; where: string;
  /** The workspace whose catalog gained the term. Null only pre-tenancy. */
  tenantOrgId?: number | null;
}) {
  try {
    // Same rule as notifyGasEmpty: one workspace's catalog, one workspace's
    // engineers.
    const to = (await houseEmails(opts.tenantOrgId ?? null)).filter((e) => e !== opts.actorEmail.toLowerCase());
    if (!to.length) return;
    const url = appUrl();
    await deliver({
      to, kind: "model_proposal", href: "/settings/catalog",
      title: `${opts.actorName} recorded "${opts.model}" (${opts.kind}) - not in the catalog yet`,
      subject: `New model to review: ${opts.model}`,
      body: `${esc(opts.actorName)} recorded a ${esc(opts.kind.toLowerCase())} as
        <b>${esc(opts.model)}</b>${opts.where ? ` on ${esc(opts.where)}` : ""} - a model the catalog doesn't know yet.
        ${mutedLine("Review it on the catalog page: accept it into the book, or fold it into an existing model's spelling.")}
        ${url ? btn(`${url}/settings/catalog`, "Review the model") : ""}`,
    });
  } catch (e) {
    console.error("[notify] model-proposal email failed:", (e as Error).message);
  }
}

export async function notifyGasEmpty(opts: { actorEmail: string; actorName: string; gas: string; instrumentId: number; externalId: string }) {
  try {
    // The engineers of the workspace whose instrument it is. houseEmails() with
    // no argument is EVERY staff member on the instance - lib/house says so:
    // "only ever right for a platform-level message: a fault reported on one
    // operator's system must not email another operator's engineers, who cannot
    // even open the link."
    const [inst] = await db.select({ tenantOrgId: instruments.tenantOrgId })
      .from(instruments).where(eq(instruments.id, opts.instrumentId));
    const to = (await houseEmails(inst?.tenantOrgId ?? null)).filter((e) => e !== opts.actorEmail.toLowerCase());
    if (!to.length) return;
    const url = appUrl();
    await deliver({
      to, kind: "gas_empty", href: `/instruments/${opts.instrumentId}`,
      title: `${opts.actorName} marked ${opts.gas} empty on ${opts.externalId}`,
      subject: `${opts.externalId}: ${opts.gas} is EMPTY`,
      body: `${esc(opts.actorName)} marked <b>${esc(opts.gas)}</b> empty on <b>${esc(opts.externalId)}</b>.
        ${url ? btn(`${url}/instruments/${opts.instrumentId}`, `Open ${opts.externalId}`) : ""}`,
    });
  } catch (e) {
    console.error("[notify] gas-empty email failed:", (e as Error).message);
  }
}

/**
 * A contract is running out.
 *
 * Sent weekly while an agreement sits inside its notice window, which is a
 * deliberate repeat rather than a one-shot: the failure this exists to prevent
 * is a contract lapsing unnoticed, and one email sixty days out that arrives on
 * a Friday afternoon is exactly how that happens. Weekly rather than daily
 * because a renewal is a conversation somebody has once, not a task they work
 * through - and a nag nobody reads protects nothing.
 */
export async function notifyRenewalDue(opts: {
  to: string[]; orgId: number; orgName: string; label: string; line: string;
  parts: string; visits: string;
}) {
  try {
    const url = appUrl();
    await deliver({
      to: opts.to, kind: "renewal", href: `/settings/organizations/${opts.orgId}`,
      title: `${opts.orgName}: ${opts.label} - ${opts.line}`,
      subject: `Renewal due - ${opts.orgName} ${opts.label}`,
      body: `<b>${esc(opts.orgName)}</b> - ${esc(opts.label)}.
        <div style="margin-top:8px;">${esc(opts.line)}</div>
        ${opts.parts || opts.visits ? mutedLine(`Used so far:
          ${[opts.parts, opts.visits].filter(Boolean).map(esc).join(" · ")}`) : ""}
        ${url ? btn(`${url}/agreements`, "Open agreements") : ""}`,
    });
  } catch (e) {
    console.error("[notify] renewal email failed:", (e as Error).message);
  }
}

/**
 * An option year has to be decided.
 *
 * Its own notice rather than a renewal one, because it is not a renewal and
 * saying so would be wrong in the way that matters: nobody is deciding whether
 * to carry on with something already running. A priced, agreed year is sitting
 * there and the client has a DEADLINE to take it, after which it is simply
 * gone. The subject line is the difference between somebody opening this in
 * October and somebody filing it with the renewal reminders.
 */
export async function notifyOptionDue(opts: {
  to: string[]; orgId: number; orgName: string; label: string;
  deadline: string; days: number | null; amount: string; lapsed: boolean;
}) {
  try {
    const url = appUrl();
    const when = opts.lapsed
      ? `The deadline was ${opts.deadline}.`
      : `They must tell us by ${opts.deadline}${opts.days !== null ? ` - ${opts.days} days` : ""}.`;
    await deliver({
      to: opts.to, kind: "renewal", href: "/money/contracts",
      title: `${opts.orgName}: ${opts.label} ${opts.lapsed ? "lapsed" : "must be exercised"} - ${opts.amount}`,
      subject: opts.lapsed
        ? `Option year LAPSED - ${opts.orgName} ${opts.label}`
        : `Option year to be exercised - ${opts.orgName} ${opts.label}`,
      body: `<b>${esc(opts.orgName)}</b> - ${esc(opts.label)}, ${esc(opts.amount)}.
        <div style="margin-top:8px;">${esc(when)}</div>
        ${mutedLine(opts.lapsed
          ? "It is not in force and is not billing. Exercising it now back-dates the term."
          : "Nothing bills for this period until it is exercised.")}
        ${url ? btn(`${url}/money/contracts`, "Open contracts") : ""}`,
    });
  } catch (e) {
    console.error("[notify] option email failed:", (e as Error).message);
  }
}

/**
 * Another service company has handed us a client.
 *
 * Deliberately says what it is worth deciding on and no more - how many
 * systems, at how many sites, and who sent it. The systems themselves are
 * behind the link, because the decision is "do we want this work" and a
 * twelve-machine list in an inbox is not how anybody makes it.
 *
 * Nothing has been written into this workspace when this arrives. That is the
 * sentence people need, because "a client was shared with you" reads like it
 * already happened.
 */
export async function notifyClientShared(opts: {
  to: string[]; fromName: string; clientName: string; summary: string; note: string;
}) {
  try {
    const url = appUrl();
    await deliver({
      to: opts.to, kind: "client_share", href: "/network",
      title: `${opts.fromName} shared ${opts.clientName} with us - ${opts.summary}`,
      subject: `${opts.fromName} wants to share ${opts.clientName} with you`,
      body: `<b>${esc(opts.fromName)}</b> has offered to share <b>${esc(opts.clientName)}</b>
        with your workspace - ${esc(opts.summary)}.
        ${opts.note ? quote(esc(opts.note)) : ""}
        ${mutedLine("Nothing has been added to your workspace. It is copied in only if you accept.")}
        ${url ? btn(`${url}/network`, "Look at it") : ""}`,
    });
  } catch (e) {
    console.error("[notify] client share email failed:", (e as Error).message);
  }
}

/**
 * Somebody is offering us work in a place we might actually go.
 *
 * Names no lab and no person - that is the whole arrangement, and an inbox
 * line naming the prospect would undo it in the one place nobody thinks to
 * check. What it carries is enough to decide whether to open the page: what
 * equipment, roughly where, and what the finder wants for it.
 *
 * It also says the race is a race. A shop that reads this on Thursday and acts
 * on Monday should know why it was gone.
 */
export async function notifyLeadOffered(opts: {
  to: string[]; fromName: string; summary: string; equipment: string; terms: string;
}) {
  try {
    const url = appUrl();
    await deliver({
      to: opts.to, kind: "lead", href: "/network",
      title: `${opts.fromName} has a lead: ${opts.summary}`,
      subject: `A lead from ${opts.fromName} - ${opts.summary}`,
      body: `<b>${esc(opts.fromName)}</b> has an inquiry they are not taking on:
        <div style="margin-top:8px;">${esc(opts.summary)}</div>
        <div>${esc(opts.equipment)}</div>
        <div style="margin-top:8px;">Their finder's fee: <b>${esc(opts.terms)}</b></div>
        ${mutedLine("Who it is stays with them until somebody claims it - and the first shop to claim it gets it.")}
        ${url ? btn(`${url}/network`, "Look at it") : ""}`,
    });
  } catch (e) {
    console.error("[notify] lead email failed:", (e as Error).message);
  }
}

/** Somebody took one of ours. The finder wants to know, and to invoice it. */
export async function notifyLeadClaimed(opts: {
  to: string[]; byName: string; summary: string;
}) {
  try {
    const url = appUrl();
    await deliver({
      to: opts.to, kind: "lead", href: "/network",
      title: `${opts.byName} claimed your lead - ${opts.summary}`,
      subject: `${opts.byName} took your lead`,
      body: `<b>${esc(opts.byName)}</b> has claimed your lead - ${esc(opts.summary)}.
        ${mutedLine("They have the contact details now. Your finder's fee is theirs to settle.")}
        ${url ? btn(`${url}/network`, "Open it") : ""}`,
    });
  } catch (e) {
    console.error("[notify] lead claim email failed:", (e as Error).message);
  }
}

/**
 * A hand-off offered to a shop with no account yet.
 *
 * The only email this app sends to somebody who is not a user, so it has to
 * carry the whole proposition and none of the client: what the work is, what
 * it costs to take, and one door. Blind, like the page it opens - see
 * lib/handoff for why that is the honest shape as well as the persuasive one.
 */
export async function notifyHandoffInvite(opts: {
  to: string; fromName: string; summary: string; terms: string; note: string; url: string;
}) {
  try {
    await deliver({
      to: [opts.to], kind: "client_share", href: opts.url,
      title: `${opts.fromName} wants to hand you ${opts.summary}`,
      subject: `${opts.fromName} has service work for you`,
      body: `<b>${esc(opts.fromName)}</b> uses Ridgeline to keep their instrument
        service records, and wants to hand a client over to you:
        <div style="margin-top:8px;font-size:15px;"><b>${esc(opts.summary)}</b></div>
        ${opts.terms ? `<div style="margin-top:8px;">What they are asking: <b>${esc(opts.terms)}</b></div>` : ""}
        ${opts.note ? quote(esc(opts.note)) : ""}
        ${mutedLine("You will see the equipment and roughly where it is. Who the client is stays with them until you accept.")}
        ${btn(opts.url, "See what is on offer")}
        ${mutedLine("Accepting opens a Ridgeline workspace for your company with this client already in it - the sites, the systems, the serials. Nothing to type in.")}`,
    });
  } catch (e) {
    console.error("[notify] handoff invite email failed:", (e as Error).message);
  }
}

/** They took it, and opened a workspace to do it in. The sender wants to know. */
export async function notifyHandoffJoined(opts: {
  to: string[]; company: string; clientName: string; systems: number;
}) {
  try {
    const url = appUrl();
    await deliver({
      to: opts.to, kind: "client_share", href: "/network",
      title: `${opts.company} joined Ridgeline and took ${opts.clientName}`,
      subject: `${opts.company} accepted your hand-off`,
      body: `<b>${esc(opts.company)}</b> opened a Ridgeline workspace and accepted
        <b>${esc(opts.clientName)}</b> - ${opts.systems} system${opts.systems === 1 ? "" : "s"}
        copied across.
        ${mutedLine("Your copy is untouched. Anything you agreed on the fee is on the network page.")}
        ${url ? btn(`${url}/network`, "Open the network") : ""}`,
    });
  } catch (e) {
    console.error("[notify] handoff joined email failed:", (e as Error).message);
  }
}

/**
 * Somebody on the staff hit a snag and said so.
 *
 * Goes to the workspace's owners rather than to everybody: it is a thing to
 * triage, not news. Carries the ROUTE, because "the invoices page" is the
 * difference between a report somebody can act on this morning and one that
 * waits for a reply asking where it happened.
 */
export async function notifyBugReport(opts: {
  to: string[]; reporter: string; title: string; where: string; blocking: boolean;
}) {
  try {
    const url = appUrl();
    await deliver({
      to: opts.to, kind: "bug_report", href: "/settings/reports",
      title: `${opts.reporter}: ${opts.title}`,
      subject: `${opts.blocking ? "Blocked - " : ""}${opts.reporter} reported a problem`,
      body: `<b>${esc(opts.reporter)}</b> reported a problem with the software:
        <div style="margin-top:8px;">${esc(opts.title)}</div>
        ${opts.where ? mutedLine(`On ${esc(opts.where)}`) : ""}
        ${opts.blocking ? mutedLine("They said it stopped them working.") : ""}
        ${url ? btn(`${url}/settings/reports`, "Open the report") : ""}`,
    });
  } catch (e) {
    console.error("[notify] bug report email failed:", (e as Error).message);
  }
}

/**
 * Somebody got in for the first time.
 *
 * Only the first: an alert per sign-in becomes a filter rule inside a week, and
 * then the one arrival that mattered is in a folder nobody opens. The first is
 * the one that answers a real question - did the person we gave access to in
 * March ever actually turn up.
 */
export async function notifyFirstSignIn(opts: {
  email: string; role: string; orgName: string;
  operatorOrgId: number | null; method: string;
}) {
  try {
    const to = await houseEmails(opts.operatorOrgId);
    // Never to the arriving person themselves - on a one-person instance the
    // owner's own first sign-in would otherwise mail them about themselves.
    const others = to.filter((e) => e.toLowerCase() !== opts.email.toLowerCase());
    if (!others.length) return;
    const url = appUrl();
    const who = opts.orgName ? `${opts.email} (${opts.orgName})` : opts.email;
    await deliver({
      to: others, kind: "sign_in", href: "/settings/activity",
      title: `${who} signed in for the first time`,
      subject: `First sign-in: ${opts.email}`,
      body: `<b>${esc(opts.email)}</b> signed in for the first time${opts.orgName ? ` for <b>${esc(opts.orgName)}</b>` : ""}.
        ${mutedLine(`Signed in with a ${opts.method === "password" ? "password" : "code"} · ${esc(opts.role || "no role")}`)}
        ${url ? btn(`${url}/settings/activity`, "See who is using the portal") : ""}`,
    });
  } catch (e) {
    console.error("[notify] first-sign-in email failed:", (e as Error).message);
  }
}

const usageRow = (r: PersonUsage, now: Date) => `
  <tr>
    <td style="padding:7px 10px;border-top:1px solid #E2E8F0;font-family:Helvetica,Arial,sans-serif;font-size:13px;">
      ${esc(r.name || r.email.split("@")[0])}<br/>
      <span style="font-size:11px;color:#64748B;">${esc(r.orgName || r.role || "")}</span>
    </td>
    <td style="padding:7px 10px;border-top:1px solid #E2E8F0;font-family:Helvetica,Arial,sans-serif;font-size:12px;white-space:nowrap;">${esc(sinceWords(r.lastSeenAt ?? r.lastLoginAt, now))}</td>
    <td style="padding:7px 10px;border-top:1px solid #E2E8F0;font-family:Helvetica,Arial,sans-serif;font-size:12px;white-space:nowrap;">${r.logins7 || "-"}</td>
  </tr>`;

/**
 * The weekly answer to "is anybody using this".
 *
 * Two lists, because they prompt two different actions: who was here (the
 * platform is earning its keep, and by whom), and who has gone quiet (somebody
 * to call before they churn, or a licence to stop paying for). Nobody active
 * and nobody quiet means no email - a report that says nothing every week
 * trains people not to open the one that says something.
 */
export function usageReportBody(opts: {
  active: PersonUsage[]; dormant: PersonUsage[]; logins: number; now: Date;
}): { title: string; body: string } {
  const url = appUrl();
  const head = (label: string) =>
    `<th align="left" style="padding:6px 10px;font-family:Helvetica,Arial,sans-serif;font-size:11px;color:#64748B;text-transform:uppercase;letter-spacing:.06em;">${label}</th>`;
  const table = (rows: PersonUsage[]) => `
    <table cellpadding="0" cellspacing="0" width="100%" style="border-collapse:collapse;margin-bottom:14px;">
      <tr>${head("Person")}${head("Last seen")}${head("Sign-ins")}</tr>
      ${rows.map((r) => usageRow(r, opts.now)).join("")}
    </table>`;
  return {
    title: `${opts.active.length} ${opts.active.length === 1 ? "person" : "people"} used the portal this week`,
    body: `${opts.active.length
      ? `<b>Here this week</b> (${opts.logins} sign-in${opts.logins === 1 ? "" : "s"})
         ${table(opts.active)}`
      : `<b>Nobody opened the portal this week.</b>`}
      ${opts.dormant.length ? `<b>Not seen in a month</b>
         ${table(opts.dormant)}` : ""}
      ${mutedLine(`Sign-ins are not visits: a session lasts 30 days, so somebody working here
        daily signs in about once a month. "Last seen" is the number that means usage.`)}
      ${url ? btn(`${url}/settings/activity`, "Open the full picture") : ""}`,
  };
}

export async function notifyUsageReport(opts: {
  to: string[]; active: PersonUsage[]; dormant: PersonUsage[];
  logins: number; now: Date;
}) {
  try {
    if (!opts.to.length || (!opts.active.length && !opts.dormant.length)) return;
    const { title, body } = usageReportBody(opts);
    await deliver({
      to: opts.to, kind: "usage_report", href: "/settings/activity",
      title, subject: `Portal usage: ${title.toLowerCase()}`, body,
    });
  } catch (e) {
    console.error("[notify] usage report email failed:", (e as Error).message);
  }
}
