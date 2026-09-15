// Closing the books.
//
// A closed month takes no new postings. A mistake found later is corrected by
// a reversing entry dated today, so the month the accountant already has never
// changes under them. The rule is two pure functions; the write is one
// UPDATE on app_settings, owner-only in the action that calls it.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appSettings } from "@/db/schema";

const YM = /^\d{4}-\d{2}$/;

/** Is a shop day inside the closed range? Blank means nothing is closed. */
export function isClosed(on: string, closedThrough: string): boolean {
  if (!YM.test(closedThrough)) return false;
  return on.slice(0, 7) <= closedThrough;
}

/**
 * Why a close would be refused, or blank. A month is closable once it has
 * ended: closing September on the 14th would refuse the rest of the month's
 * own postings. Reopening (an earlier month, or blank) is allowed - it is a
 * decision, and the audit row names who made it.
 */
export function closeProblem(ym: string, today: string): string {
  if (ym !== "" && !YM.test(ym)) return "Pick a month, like 2026-08.";
  if (ym !== "" && ym >= today.slice(0, 7)) return "That month has not ended. Close it once it has.";
  return "";
}

/** Owner-only at the action; this is only the write. */
export async function closeBooksThrough(ym: string, today: string, tx = db): Promise<{ error?: string; was: string }> {
  const problem = closeProblem(ym, today);
  const [row] = await tx.select({ ym: appSettings.booksClosedThrough }).from(appSettings).where(eq(appSettings.id, 1));
  const was = row?.ym ?? "";
  if (problem) return { error: problem, was };
  await tx.update(appSettings).set({ booksClosedThrough: ym }).where(eq(appSettings.id, 1));
  return { was };
}
