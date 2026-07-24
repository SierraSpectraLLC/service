// Event notifications (email via Resend). Deliberately just two events - the
// daily digest covers routine status. Every send is wrapped so a mail failure
// can never fail the action that triggered it.
import { db } from "@/db";
import { users } from "@/db/schema";
import { parseList } from "@/lib/allowMatch";
import { sendEmail } from "@/lib/email";

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const appUrl = () =>
  process.env.APP_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "");

/**
 * Assignees are freeform first names ("Joe", "Bill"). Resolve to an email by
 * (1) exact users.name match, then (2) a staff email whose local part starts
 * with the name (joe -> joe.vincent96@...). Null when nothing matches - the
 * caller skips the notification rather than guessing.
 */
export function resolveAssigneeEmail(
  name: string,
  staffEmails: string[],
  userRows: { name: string | null; email: string }[],
): string | null {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  const byName = userRows.find((u) => (u.name || "").trim().toLowerCase() === n);
  if (byName) return byName.email.toLowerCase();
  return staffEmails.find((e) => e.split("@")[0].startsWith(n)) ?? null;
}

const wrap = (body: string) => `
  <div style="font-family:Helvetica,Arial,sans-serif;font-size:14px;color:#172A4A;">
    <div style="font-weight:bold;letter-spacing:0.3px;margin-bottom:10px;">SIERRA SPECTRA</div>
    ${body}
  </div>`;

export async function notifyTaskAssigned(opts: {
  actorEmail: string; actorName: string; assignee: string;
  taskTitle: string; instrumentId: number; externalId: string;
}) {
  try {
    const staff = parseList(process.env.STAFF_EMAILS);
    const userRows = await db.select({ name: users.name, email: users.email }).from(users);
    const to = resolveAssigneeEmail(opts.assignee, staff, userRows);
    if (!to || to === opts.actorEmail.toLowerCase()) return; // unknown assignee or self-assign
    const url = appUrl();
    await sendEmail(
      [to],
      `${opts.externalId}: assigned "${opts.taskTitle}"`,
      wrap(`${esc(opts.actorName)} assigned you <b>${esc(opts.taskTitle)}</b> on <b>${esc(opts.externalId)}</b>.
        ${url ? `<div style="margin-top:10px;"><a href="${url}/instruments/${opts.instrumentId}">Open ${esc(opts.externalId)}</a></div>` : ""}`),
    );
  } catch (e) {
    console.error("[notify] task-assigned email failed:", (e as Error).message);
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
