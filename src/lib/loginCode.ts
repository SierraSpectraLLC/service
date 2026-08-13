// Signing in from a lab PC.
//
// The magic link assumes the machine you are signing in ON is the machine your
// email is open on. At an instrument that is false: the controller runs
// LabSolutions and nothing else, nobody wants a mail client on it, and "open
// your email here" is how a shared password gets written on a label instead.
//
// So the same email now carries a six-digit code as well as the link. Read it on
// your phone, type it on the bench. The link still works when you are on a phone
// or a laptop, because tapping is faster than typing when tapping is possible.
//
// A short code is a weaker credential than a long one, and the arithmetic is the
// whole design: six digits is a million combinations, so a code that lived for a
// day and accepted unlimited guesses would be worth about as much as a PIN taped
// to the monitor. Three things keep it honest, and they are all here so they can
// be argued with in a test:
//
//   * it expires in minutes, not hours
//   * a handful of wrong guesses locks that address out of code entry
//   * asking for codes over and over is itself limited
//
// At the numbers below, an attacker who knows an address gets 6 guesses per
// 15 minutes: about a 1-in-160,000 chance per window, and every failure is a row
// somebody can look at.

/** Digits in a code. Six is what people can hold in their head from a phone. */
export const CODE_DIGITS = 6;

/** How long a code is good for. Long enough to walk to the instrument. */
export const CODE_TTL_MINUTES = 15;

/** Wrong guesses before that address has to ask for a new code. */
export const MAX_ATTEMPTS = 6;

/** Codes one address may ask for inside a window, so mail can't be weaponized. */
export const MAX_REQUESTS = 5;
export const REQUEST_WINDOW_MINUTES = 15;

/** How long a lock lasts once either limit is hit. */
export const LOCK_MINUTES = 15;

/**
 * A code from real randomness, leading zeros kept.
 *
 * `randomInt` rather than Math.random: this is a credential, and the difference
 * between the two is the difference between a secret and a pattern. Taking a
 * modulus of a random byte would bias the low digits, which is why the range
 * form is used instead.
 */
export function newCode(randomInt: (min: number, max: number) => number): string {
  const max = 10 ** CODE_DIGITS;
  return String(randomInt(0, max)).padStart(CODE_DIGITS, "0");
}

/** Only ever six digits - anything else is a typo or a probe, and costs nothing to reject. */
export const isCodeShaped = (raw: string) => new RegExp(`^\\d{${CODE_DIGITS}}$`).test(raw.trim());

/**
 * People paste "123 456" and "123-456" off a phone screen. Accepting that is not
 * laxity: the code is still exactly six digits, we just stop punishing the space.
 */
export const normalizeCode = (raw: string) => raw.replace(/[\s-]/g, "").trim();

export type AttemptRow = {
  /** Wrong guesses since the counter last reset. */
  attempts: number;
  /** Codes asked for since the counter last reset. */
  requests: number;
  /** When the current window started. */
  windowStart: Date;
  /** Set when a limit was hit; until then, nothing is refused. */
  lockedUntil: Date | null;
};

export type Verdict =
  | { allow: true; row: AttemptRow }
  | { allow: false; reason: string; retryAfterMinutes: number };

const mins = (n: number) => n * 60_000;

/** A fresh counter, for an address that has never asked. */
export const freshAttempts = (now: Date): AttemptRow =>
  ({ attempts: 0, requests: 0, windowStart: now, lockedUntil: null });

/** The counter, with an expired window rolled over. */
export function rolled(row: AttemptRow, now: Date): AttemptRow {
  const expired = now.getTime() - row.windowStart.getTime() >= mins(REQUEST_WINDOW_MINUTES);
  return expired ? freshAttempts(now) : row;
}

const lockVerdict = (row: AttemptRow, now: Date, reason: string): Verdict => ({
  allow: false, reason,
  retryAfterMinutes: Math.max(1, Math.ceil(((row.lockedUntil?.getTime() ?? now.getTime()) - now.getTime()) / 60_000)),
});

/** May this address be sent another code? */
export function maySendCode(row: AttemptRow | null, now: Date): Verdict {
  // The ask being answered counts as one, or the first five would be free.
  if (!row) return { allow: true, row: { ...freshAttempts(now), requests: 1 } };
  if (row.lockedUntil && row.lockedUntil > now) {
    return lockVerdict(row, now, "Too many sign-in attempts for that address.");
  }
  const cur = rolled(row, now);
  if (cur.requests >= MAX_REQUESTS) {
    const locked = { ...cur, lockedUntil: new Date(now.getTime() + mins(LOCK_MINUTES)) };
    return lockVerdict(locked, now, "That's a lot of codes in a short time.");
  }
  return { allow: true, row: { ...cur, requests: cur.requests + 1 } };
}

/** May this address try a code at all? Checked before the code is even looked at. */
export function mayTryCode(row: AttemptRow | null, now: Date): Verdict {
  if (!row) return { allow: true, row: freshAttempts(now) };
  if (row.lockedUntil && row.lockedUntil > now) {
    return lockVerdict(row, now, "Too many wrong codes.");
  }
  return { allow: true, row: rolled(row, now) };
}

/**
 * The counter after a wrong guess, and whether that guess was the last one.
 * Locking on the way past the limit rather than at the next attempt means the
 * refusal is immediate instead of one guess late.
 */
export function afterWrongCode(row: AttemptRow, now: Date): { row: AttemptRow; locked: boolean } {
  const attempts = row.attempts + 1;
  const locked = attempts >= MAX_ATTEMPTS;
  return {
    row: { ...row, attempts, lockedUntil: locked ? new Date(now.getTime() + mins(LOCK_MINUTES)) : row.lockedUntil },
    locked,
  };
}

/** Guesses left to show someone who just mistyped. */
export const guessesLeft = (row: AttemptRow) => Math.max(0, MAX_ATTEMPTS - row.attempts);
