// A password an owner hands to somebody, out loud.
//
// The ordinary way in is a six-digit code by email (lib/loginCode). When mail
// is not arriving at all - a young domain nobody's filters trust yet, a
// provider sitting on a fourteen-day reputation timeout - that path is not
// slow, it is closed, and the person on the other end cannot start work.
//
// So an owner can set one for them. Three things keep that from being a
// permanent hole, and all three are here so they can be argued with in a test:
//
//   * it is generated, not invented - nobody types "Welcome2026" into this
//   * it is spoken, not mailed: three words and four digits survive a phone
//     call, and never travel through the channel that is already broken
//   * it EXPIRES, on a date the person who set it chose, after which it fails
//     like any wrong password and the account is back to codes
//
// The words avoid anything a listener could mishear into a different word of
// the list, and anything that reads as an instruction when read aloud.

/** Words chosen to be unambiguous over a bad phone line. */
const WORDS = [
  "anchor", "basalt", "cobalt", "dahlia", "ember", "fathom", "garnet", "harbor",
  "indigo", "juniper", "kelvin", "lantern", "marble", "nectar", "opal", "pumice",
  "quartz", "ribbon", "saffron", "timber", "umber", "velvet", "walnut", "yarrow",
  "zephyr", "beacon", "cinder", "drifter", "elm", "flint", "granite", "hollow",
];

/** How long a loan lasts unless somebody says otherwise. */
export const TEMP_DAYS_DEFAULT = 14;
/** The longest one anybody can set. A month is not a loan. */
export const TEMP_DAYS_MAX = 30;

/**
 * Three words and four digits: "harbor-quartz-elm-4193". Long enough to satisfy
 * lib/password, short enough to read down a phone, and drawn from `random`
 * rather than Math.random so the caller supplies the CSPRNG and a test can
 * supply a rigged one.
 */
export function makeTempPassword(random: (max: number) => number): string {
  const picked: string[] = [];
  while (picked.length < 3) {
    const w = WORDS[random(WORDS.length)];
    if (!picked.includes(w)) picked.push(w);
  }
  const digits = String(1000 + random(9000));
  return `${picked.join("-")}-${digits}`;
}

/** Midnight-free arithmetic: the same clock time, `days` later. */
export function tempExpiry(days: number, now: Date): Date {
  const d = Math.min(TEMP_DAYS_MAX, Math.max(1, Math.round(days || TEMP_DAYS_DEFAULT)));
  return new Date(now.getTime() + d * 86_400_000);
}

export type TempState =
  | { kind: "none" }
  | { kind: "own" }
  | { kind: "active"; daysLeft: number; line: string }
  | { kind: "expired"; line: string };

/**
 * What to say about the password on somebody's account, from the two columns
 * that describe it. "Own" is the one nobody administers: the person set it
 * themselves and it does not expire.
 */
export function tempState(
  row: { passwordHash: string; passwordTempUntil: Date | null }, now: Date,
): TempState {
  if (!row.passwordHash) return { kind: "none" };
  if (!row.passwordTempUntil) return { kind: "own" };
  const ms = row.passwordTempUntil.getTime() - now.getTime();
  if (ms <= 0) return { kind: "expired", line: "Temporary password has expired - codes only." };
  const daysLeft = Math.ceil(ms / 86_400_000);
  return {
    kind: "active", daysLeft,
    line: daysLeft === 1 ? "Temporary password, expires today" : `Temporary password, ${daysLeft} days left`,
  };
}
