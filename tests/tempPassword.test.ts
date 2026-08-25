// The password an owner reads down a phone.
//
// It exists because the ordinary way in - a code by email - is not slow when a
// domain is young, it is closed. Everything worth testing here is about the
// ways that stopgap could quietly become permanent, or guessable.
import { describe, expect, it } from "vitest";
import { makeTempPassword, tempExpiry, tempState, TEMP_DAYS_DEFAULT, TEMP_DAYS_MAX } from "@/lib/tempPassword";
import { passwordProblem, MIN_PASSWORD } from "@/lib/password";

/** A rigged CSPRNG: predictable, so the assertions can be exact. */
const rigged = (seq: number[]) => {
  let i = 0;
  return (max: number) => seq[i++ % seq.length] % max;
};

describe("what gets generated", () => {
  it("is three distinct words and four digits", () => {
    const p = makeTempPassword(rigged([0, 1, 2, 3456]));
    expect(p).toMatch(/^[a-z]+-[a-z]+-[a-z]+-\d{4}$/);
    const words = p.split("-").slice(0, 3);
    expect(new Set(words).size).toBe(3);
  });

  it("never repeats a word even when the random source does", () => {
    // The same index four times running would otherwise make "elm-elm-elm".
    const p = makeTempPassword(rigged([7, 7, 7, 7, 8, 9, 1234]));
    const words = p.split("-").slice(0, 3);
    expect(new Set(words).size).toBe(3);
  });

  it("passes the app's own password rules, whatever it draws", () => {
    // Every one of these has to be settable: a generated password that the
    // setter then rejects is a feature that fails at random.
    for (let i = 0; i < 200; i++) {
      const p = makeTempPassword((max) => Math.floor(Math.random() * max));
      expect(p.length).toBeGreaterThanOrEqual(MIN_PASSWORD);
      expect(passwordProblem(p, "somebody@example.com")).toBeNull();
    }
  });
});

describe("when it stops working", () => {
  const now = new Date("2026-08-25T17:00:00Z");

  it("defaults to a fortnight and honours a shorter loan", () => {
    expect(tempExpiry(TEMP_DAYS_DEFAULT, now).toISOString()).toBe("2026-09-08T17:00:00.000Z");
    expect(tempExpiry(3, now).toISOString()).toBe("2026-08-28T17:00:00.000Z");
  });

  it("refuses to hand out more than a month, however it is asked", () => {
    expect(tempExpiry(365, now).getTime()).toBe(tempExpiry(TEMP_DAYS_MAX, now).getTime());
    // Nonsense reads as the default rather than as "never expires".
    expect(tempExpiry(0, now).getTime()).toBe(tempExpiry(TEMP_DAYS_DEFAULT, now).getTime());
    expect(tempExpiry(-5, now).getTime()).toBe(tempExpiry(1, now).getTime());
  });
});

describe("what the people list says about somebody", () => {
  const now = new Date("2026-08-25T17:00:00Z");
  const at = (iso: string | null) => ({ passwordHash: "scrypt$...", passwordTempUntil: iso ? new Date(iso) : null });

  it("says nothing when there is no password", () => {
    expect(tempState({ passwordHash: "", passwordTempUntil: null }, now).kind).toBe("none");
  });

  it("leaves a password somebody chose themselves alone", () => {
    // No expiry, so nobody administers it and nobody should be offered a
    // button to take it away as though it were a loan.
    expect(tempState(at(null), now).kind).toBe("own");
  });

  it("counts the days down and rounds up, so 'today' means today", () => {
    const s = tempState(at("2026-08-31T09:00:00Z"), now);
    expect(s.kind).toBe("active");
    if (s.kind === "active") {
      expect(s.daysLeft).toBe(6);
      expect(s.line).toBe("Temporary password, 6 days left");
    }
    const last = tempState(at("2026-08-25T23:00:00Z"), now);
    if (last.kind === "active") expect(last.line).toBe("Temporary password, expires today");
  });

  it("calls an elapsed one expired, at the second it passes", () => {
    expect(tempState(at("2026-08-25T17:00:00Z"), now).kind).toBe("expired");
    expect(tempState(at("2026-08-25T16:59:59Z"), now).kind).toBe("expired");
    expect(tempState(at("2026-08-25T17:00:01Z"), now).kind).toBe("active");
  });
});
