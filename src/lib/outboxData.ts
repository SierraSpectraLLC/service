import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { emailOutbox } from "@/db/schema";
import { sendEmail } from "@/lib/email";
import { appUrl } from "@/lib/appUrl";
import { wrapNotification } from "@/lib/notifyShell";
import { holdFor } from "@/lib/inbox";
import {
  MAX_HOLD_SECONDS, batchEmail, dueAt, groupHeld, type Held,
} from "@/lib/outbox";

/**
 * The queue behind lib/outbox: put an email down, pick the due ones up.
 *
 * Every function here swallows its own failure, for the same reason lib/notify
 * does: an assignment must not fail because the mailer's waiting room is
 * broken. The inbox row is already written by the time anything in this file
 * runs, so the worst outcome available is a missing email.
 */

/** What one held email needs to know about itself. */
export type Queued = {
  email: string;
  kind: string;
  title: string;
  href: string;
  subject: string;
  body: string;
  actor: string;
  context: string;
  item: string;
};

/**
 * Hold an email, and push the rest of its burst out with it.
 *
 * The push is the whole mechanism. Every unsent row for this recipient and
 * kind gets the new deadline, so the wait always measures the silence since
 * the LAST item rather than the age of the first - which is what makes five
 * assignments one email instead of five, however long the person takes to
 * type them.
 *
 * Deliberately keyed on recipient and KIND rather than the narrower batch key
 * the email is grouped by: somebody assigning tasks across two systems should
 * get both emails at once when they stop, not one now and one in a minute.
 */
export async function queueEmail(rows: Queued[], now = new Date()): Promise<void> {
  if (!rows.length) return;
  try {
    for (const r of rows) {
      const hold = holdFor(r.kind);
      if (!hold) continue;
      const after = dueAt(now, hold.seconds);
      await db.update(emailOutbox)
        .set({ sendAfter: after })
        .where(and(
          eq(emailOutbox.email, r.email),
          eq(emailOutbox.kind, r.kind),
          isNull(emailOutbox.sentAt),
        ));
      await db.insert(emailOutbox).values({
        ...r,
        sendAfter: after,
        // Fixed at the moment this row is written and never moved again.
        sendBy: dueAt(now, MAX_HOLD_SECONDS),
      });
    }
  } catch (e) {
    console.error("[outbox] could not hold an email:", (e as Error).message);
  }
}

/**
 * Send everything that has come due, and say how many went.
 *
 * Claimed before sent: the rows are stamped `sent_at` in one UPDATE and only
 * then handed to the mailer, so two flushes racing each other - the bell
 * poller and the cron arriving together - cannot both send the same batch. The
 * cost of that order is the honest one: a mailer that fails after the claim
 * loses the email rather than repeating it, which is the right way round for
 * something whose in-app record already exists.
 */
export async function flushOutbox(now = new Date()): Promise<number> {
  try {
    const due = await db.select().from(emailOutbox).where(and(
      isNull(emailOutbox.sentAt),
      or(lte(emailOutbox.sendAfter, now), lte(emailOutbox.sendBy, now)),
    )).orderBy(asc(emailOutbox.id)).limit(500);
    if (!due.length) return 0;

    await db.update(emailOutbox)
      .set({ sentAt: now })
      .where(inArray(emailOutbox.id, due.map((r) => r.id)));

    const url = appUrl();
    let sent = 0;
    for (const batch of groupHeld(due as Held[])) {
      const hold = holdFor(batch[0].kind);
      const { subject, body, preheader } = batchEmail(batch, hold?.plural ?? "items", url);
      // Each batch on its own, so one bad address cannot swallow the rest.
      try {
        await sendEmail([batch[0].email], subject, await wrapNotification(body, { preheader }));
        sent++;
      } catch (e) {
        console.error("[outbox] batch failed:", (e as Error).message);
      }
    }
    return sent;
  } catch (e) {
    console.error("[outbox] flush failed:", (e as Error).message);
    return 0;
  }
}

/**
 * Rows old enough that nobody is waiting for them any more.
 *
 * Sent rows are kept a while so "why did this arrive late" has an answer on
 * the record, then swept - a queue table that only grows is a queue table
 * somebody eventually has to explain.
 */
export const OUTBOX_KEEP_DAYS = 14;

export async function pruneOutbox(now = new Date()): Promise<void> {
  try {
    const cutoff = new Date(now.getTime() - OUTBOX_KEEP_DAYS * 86400000);
    await db.delete(emailOutbox).where(and(
      sql`${emailOutbox.sentAt} is not null`,
      lte(emailOutbox.sentAt, cutoff),
    ));
  } catch {
    /* A queue that fails to tidy itself still works. */
  }
}
