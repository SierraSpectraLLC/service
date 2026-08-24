// The nightly pass over the ladder.
//
// It sends at most one rung per invoice per day, and only when the calendar
// says that rung is due. Two disciplines it keeps, both learned from the
// digest:
//
//   THE SEND HOUR. Reminders go out with the morning, not at whatever hour the
//   cron happened to fire. A dunning notice that lands at 2am reads as
//   automated, and an automated dunning notice is one nobody replies to.
//
//   AUTO IS A SETTING. An org with dunningAuto off gets nothing sent; its
//   rungs sit in Collections as work somebody presses. Some clients are worth
//   phoning rather than mailing, and the software should not decide that.
//
// The run is idempotent by construction: a rung is skipped once it has a
// dunning_events row, so firing this twice in an hour sends nothing twice.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { appSettings, orgs } from "@/db/schema";
import { shopDay, shopHour } from "@/lib/shopday";
import { collectionsBoard } from "@/lib/invoiceData";
import { sendDunningRung } from "@/app/actions";

export type DunningResult = {
  sent: { invoice: string; rung: string }[];
  skipped: string[];
  /** Invoices with a rung due that nobody has pressed. Reported, not sent. */
  waiting: { invoice: string; rung: string; reason: string }[];
};

/**
 * The hour reminders go out. Shared with the digest deliberately: an operator
 * has one "morning", and having collections keep a second one is a setting
 * nobody would remember existed.
 */
export const sendHourFor = (
  org: { digestHour: number } | null,
  settings: { digestHour: number } | null,
): number => org?.digestHour ?? settings?.digestHour ?? 7;

export async function runDunning(now = new Date()): Promise<DunningResult> {
  const today = shopDay(now);
  const hourNow = shopHour(now);
  const [allOrgs, [settings]] = await Promise.all([
    db.select().from(orgs),
    db.select().from(appSettings).where(eq(appSettings.id, 1)),
  ]);
  const orgById = new Map(allOrgs.map((o) => [o.id, o]));

  const board = await collectionsBoard(today);
  const out: DunningResult = { sent: [], skipped: [], waiting: [] };

  for (const item of board) {
    const number = item.invoice.row.number;
    if (!item.step) continue;

    const org = orgById.get(item.invoice.row.orgId) ?? null;
    const hour = sendHourFor(org, settings ?? null);
    if (hourNow !== hour) {
      out.skipped.push(`${number}: not the send hour for ${org?.name ?? "this client"}`);
      continue;
    }
    if (!item.policy.dunningAuto) {
      out.waiting.push({
        invoice: number, rung: item.step.rung.key,
        reason: `automatic reminders are off for ${org?.name ?? "this client"} - it is waiting for somebody to press it`,
      });
      continue;
    }
    // The last rung is an export somebody assembles and hands over. Nothing
    // about referring an account to collections should happen because a cron
    // fired at seven in the morning.
    if (item.step.rung.channel === "export") {
      out.waiting.push({
        invoice: number, rung: item.step.rung.key,
        reason: "referring an account is a decision, not a scheduled job",
      });
      continue;
    }

    const res = await sendDunningRung(item.invoice.row.id, { actor: "auto" });
    if (res.error) out.skipped.push(`${number}: ${res.error}`);
    else out.sent.push({ invoice: number, rung: res.rung ?? item.step.rung.key });
  }
  return out;
}
