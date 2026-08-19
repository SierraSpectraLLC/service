// Event notifications: an inbox row per recipient, then email via Resend.
// Every send is wrapped so a mail failure can never fail the action that
// triggered it. Magic links deliberately don't come through here - sign-in
// mail is auth infrastructure (src/auth.ts), not a notification anyone may
// opt out of or needs a record of.
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { users, notifications, notificationPrefs } from "@/db/schema";
import { houseEmails } from "@/lib/house";
import { sendEmail } from "@/lib/email";
import { emailAllowed, type NotifyKind } from "@/lib/inbox";
import { getBrand } from "@/lib/brand";
import { appUrl } from "@/lib/appUrl";
import { namedLogins } from "@/lib/directory";
import { emailShell, esc, btn, quote, mutedLine } from "@/lib/emailTheme";

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
}) {
  const emails = [...new Set(opts.to.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (!emails.length) return;
  await db.insert(notifications).values(emails.map((email) => ({
    email, kind: opts.kind, title: opts.title.slice(0, 200), href: opts.href,
  })));
  const prefRows = await db.select().from(notificationPrefs).where(inArray(notificationPrefs.email, emails));
  const wantEmail = emails.filter((e) => emailAllowed(prefRows.filter((p) => p.email === e), opts.kind));
  if (wantEmail.length) await sendEmail(wantEmail, opts.subject, await wrap(opts.body, { preheader: opts.title }));
}

// System notifications are sent by the platform, so they carry its name rather
// than any one service company's - see lib/brand.ts. The footer points at the
// inbox because that is where the email switches live - except on the invite,
// whose recipient has never signed in and has no inbox to manage yet.
const wrap = async (body: string, opts: { preheader?: string; prefsFooter?: boolean } = {}) => {
  const brand = (await getBrand()).name;
  const url = appUrl();
  const footer = `Sent by ${esc(brand)}.${opts.prefsFooter !== false && url
    ? ` <a href="${url}/inbox" style="color:#94A3B8;">Choose which emails you get</a>.`
    : ""}`;
  return emailShell({ brand, preheader: opts.preheader, body, footer });
};

export async function notifyTaskAssigned(opts: {
  actorEmail: string; actorName: string; assignee: string;
  // A task lives on a system, on a standalone asset, or both - the link points
  // at whichever page owns it.
  taskTitle: string; instrumentId?: number; assetId?: number; externalId: string;
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
    const href = opts.instrumentId ? `/instruments/${opts.instrumentId}` : opts.assetId ? `/assets/${opts.assetId}` : "";
    await deliver({
      to: [to], kind: "task_assigned", href,
      title: `${opts.actorName} assigned you "${opts.taskTitle}" on ${opts.externalId}`,
      subject: `${opts.externalId}: assigned "${opts.taskTitle}"`,
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
export async function notifyInvite(opts: { to: string; inviterName: string; orgName: string }) {
  try {
    const brand = (await getBrand()).name;
    const url = appUrl();
    await sendEmail(
      [opts.to],
      `${opts.inviterName} invited you to ${brand}`,
      await wrap(`${esc(opts.inviterName)} added you to <b>${esc(opts.orgName)}</b>'s workspace on ${esc(brand)}.
        ${url ? `${btn(`${url}/login`, "Sign in")}
        ${mutedLine("Use this email address - no password, a sign-in code is emailed to you.")}` : ""}`,
      { preheader: `${opts.inviterName} added you to ${opts.orgName}'s workspace`, prefsFooter: false }),
    );
  } catch (e) {
    console.error("[notify] invite email failed:", (e as Error).message);
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
}) {
  try {
    const to = (await houseEmails()).filter((e) => e !== opts.actorEmail.toLowerCase());
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
    const to = (await houseEmails()).filter((e) => e !== opts.actorEmail.toLowerCase());
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
