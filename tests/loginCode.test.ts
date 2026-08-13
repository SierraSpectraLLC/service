import { describe, expect, it } from "vitest";
import {
  afterWrongCode, CODE_DIGITS, freshAttempts, guessesLeft, isCodeShaped, LOCK_MINUTES,
  maySendCode, mayTryCode, MAX_ATTEMPTS, MAX_REQUESTS, newCode, normalizeCode, rolled,
} from "@/lib/loginCode";

/**
 * A six-digit code is a million combinations, which is only a credential because
 * of the limits around it. These are those limits, so the arithmetic in the
 * module header is a claim somebody checked rather than a claim somebody made.
 */
const T0 = new Date("2026-08-13T10:00:00Z");
const at = (mins: number) => new Date(T0.getTime() + mins * 60_000);

describe("the code itself", () => {
  it("is always six digits, leading zeros kept", () => {
    // The bug this prevents: String(4) is "4", and a five-character code both
    // looks broken and shrinks the space it is drawn from.
    expect(newCode(() => 4)).toBe("000004");
    expect(newCode(() => 999999)).toBe("999999");
    expect(newCode(() => 42).length).toBe(CODE_DIGITS);
  });

  it("draws from the whole range, without a modulus bias", () => {
    let seen: [number, number] | null = null;
    newCode((min, max) => { seen = [min, max]; return 1; });
    expect(seen).toEqual([0, 10 ** CODE_DIGITS]);
  });

  it("accepts what a phone screen puts on the clipboard", () => {
    expect(normalizeCode(" 123 456 ")).toBe("123456");
    expect(normalizeCode("123-456")).toBe("123456");
  });

  it("rejects anything that is not six digits", () => {
    expect(isCodeShaped("123456")).toBe(true);
    expect(isCodeShaped("12345")).toBe(false);
    expect(isCodeShaped("1234567")).toBe(false);
    expect(isCodeShaped("12345a")).toBe(false);
    expect(isCodeShaped("")).toBe(false);
  });
});

describe("asking for codes", () => {
  it("allows the first ask from an address nobody has seen", () => {
    const v = maySendCode(null, T0);
    expect(v.allow).toBe(true);
    if (v.allow) expect(v.row.requests).toBe(1);
  });

  it("counts them up to the limit, then locks", () => {
    let row = freshAttempts(T0);
    for (let i = 0; i < MAX_REQUESTS; i++) {
      const v = maySendCode(row, T0);
      expect(v.allow).toBe(true);
      if (v.allow) row = v.row;
    }
    const over = maySendCode(row, T0);
    expect(over.allow).toBe(false);
    if (!over.allow) expect(over.retryAfterMinutes).toBeLessThanOrEqual(LOCK_MINUTES);
  });

  it("forgives once the window has passed", () => {
    // Somebody who asked five times this morning is not locked out this
    // afternoon; the counter is a rate limit, not a punishment.
    const spent = { ...freshAttempts(T0), requests: MAX_REQUESTS };
    const v = maySendCode(spent, at(16));
    expect(v.allow).toBe(true);
    if (v.allow) expect(v.row.requests).toBe(1);
  });

  it("says nothing while a lock is live, however the window falls", () => {
    const locked = { ...freshAttempts(T0), lockedUntil: at(10) };
    expect(maySendCode(locked, at(5)).allow).toBe(false);
    expect(maySendCode(locked, at(11)).allow).toBe(true);
  });
});

describe("guessing codes", () => {
  it("locks the address after the last wrong guess, not one guess later", () => {
    let row = freshAttempts(T0);
    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      const r = afterWrongCode(row, T0);
      expect(r.locked).toBe(false);
      row = r.row;
    }
    const last = afterWrongCode(row, T0);
    expect(last.locked).toBe(true);
    expect(mayTryCode(last.row, T0).allow).toBe(false);
  });

  it("counts down the guesses somebody has left", () => {
    const row = { ...freshAttempts(T0), attempts: MAX_ATTEMPTS - 2 };
    expect(guessesLeft(row)).toBe(2);
    expect(guessesLeft({ ...row, attempts: 99 })).toBe(0);
  });

  it("lets them try again when the lock lifts", () => {
    const locked = { ...freshAttempts(T0), attempts: MAX_ATTEMPTS, lockedUntil: at(LOCK_MINUTES) };
    expect(mayTryCode(locked, at(LOCK_MINUTES - 1)).allow).toBe(false);
    const after = mayTryCode(locked, at(LOCK_MINUTES + 1));
    expect(after.allow).toBe(true);
    // And with a clean slate, since the window rolled over with it.
    if (after.allow) expect(after.row.attempts).toBe(0);
  });

  it("tells somebody how long to wait, in whole minutes and never zero", () => {
    const locked = { ...freshAttempts(T0), lockedUntil: new Date(T0.getTime() + 20_000) };
    const v = mayTryCode(locked, T0);
    expect(v.allow).toBe(false);
    if (!v.allow) expect(v.retryAfterMinutes).toBe(1);
  });
});

describe("the window", () => {
  it("rolls over only once it has actually passed", () => {
    const row = { ...freshAttempts(T0), requests: 3, attempts: 2 };
    expect(rolled(row, at(14)).requests).toBe(3);
    expect(rolled(row, at(15)).requests).toBe(0);
    expect(rolled(row, at(15)).attempts).toBe(0);
  });
});
