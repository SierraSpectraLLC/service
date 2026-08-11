// One timestamp format, produced identically wherever it runs.
//
// Client components render twice - once on the server to make the HTML, once in
// the browser to hydrate it - and both renders have to agree. `toLocaleString`
// with no timeZone agrees with nothing: the server runs in UTC, the bench PC
// runs in Pacific, so every timestamp on a hydrated page mismatched. Even with
// a fixed timeZone the *literals* are engine business - recent ICU puts a
// narrow no-break space before "PM" where older ICU used a plain space, so
// Node and a given browser can disagree character-for-character.
//
// So: ask Intl only for the numbers, and assemble the string here. The parts
// are stable across engines; the punctuation is ours.

/**
 * The shop's timezone. Deliberately NOT read from process.env: this module runs
 * in the browser too, where SHOP_TZ doesn't exist, and a helper that silently
 * used a different zone on each side would reintroduce the mismatch it exists
 * to prevent. An instance in another zone changes this constant.
 */
export const SHOP_TZ = "America/Los_Angeles";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Aug 11, 4:38 PM" in shop time. Accepts an ISO string or a Date. */
export function fmtWhen(value: string | Date, tz: string = SHOP_TZ): string {
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, month: "numeric", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const month = MONTHS[(parseInt(get("month"), 10) || 1) - 1];
  // dayPeriod comes back as "AM"/"PM", "am"/"pm" or "p.m." depending on the
  // engine; only which half of the day it names is information.
  const ampm = get("dayPeriod").trim().toUpperCase().startsWith("P") ? "PM" : "AM";
  return `${month} ${get("day")}, ${get("hour")}:${get("minute")} ${ampm}`;
}
