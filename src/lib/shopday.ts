// "Today" in shop time, not server (UTC) time - Vercel crons and late-evening
// edits would otherwise roll to the wrong day.
const TZ = () => process.env.SHOP_TZ || "America/Los_Angeles";

/** YYYY-MM-DD, used as the eod_updates row key. */
export function shopToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: TZ() });
}

/** MM/DD/YY, the header format the client's email template uses. */
export function shopTodayMDY(): string {
  return new Date().toLocaleDateString("en-US", { timeZone: TZ(), month: "2-digit", day: "2-digit", year: "2-digit" });
}
