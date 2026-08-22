// "Today" in shop time, not server (UTC) time - Vercel crons and late-evening
// edits would otherwise roll to the wrong day.
import { fmtWhen, SHOP_TZ } from "@/lib/when";

const TZ = () => process.env.SHOP_TZ || SHOP_TZ;

/** YYYY-MM-DD, used as the eod_updates row key. */
export function shopToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ() });
}

/** MM/DD/YY, the header format the client's email template uses. */
export function shopTodayMDY(): string {
  return new Date().toLocaleDateString("en-US", { timeZone: TZ(), month: "2-digit", day: "2-digit", year: "2-digit" });
}

/**
 * "Jul 22, 1:19 PM" in shop time - for server-rendered timestamps (the server
 * runs in UTC). Same formatter the client components use, so one timestamp
 * doesn't read differently depending on which side rendered it.
 */
export function shopTime(d: Date): string {
  return fmtWhen(d, TZ());
}

/** The shop day a moment fell on: YYYY-MM-DD, for grouping history by visit. */
export function shopDay(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: TZ() });
}

/** "Jul 22" in shop time - for the free-text date stamps on parts. */
export function shopMonthDay(d: Date = new Date()): string {
  return d.toLocaleDateString("en-US", { timeZone: TZ(), month: "short", day: "numeric" });
}

/**
 * The hour (0-23) it is now in shop time. The digest cron runs hourly and
 * compares this against each organization's configured send hour, which is how
 * "send it at eight" became a dropdown instead of a deploy.
 *
 * hourCycle h23 rather than hour12:false: the latter renders midnight as "24"
 * in en-US on some runtimes, and an hour that never equals 0 would silently
 * skip every schedule set to midnight.
 */
export function shopHour(d: Date = new Date()): number {
  return parseInt(d.toLocaleString("en-US", { timeZone: TZ(), hour: "2-digit", hourCycle: "h23" }), 10);
}
