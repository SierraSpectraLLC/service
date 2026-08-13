import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  hashPassword, MIN_PASSWORD, needsRehash, parseHash, passwordProblem, SCRYPT_N, verifyPassword,
} from "@/lib/password";

const scryptAsync = promisify(scryptCb) as (p: string, s: Buffer, k: number, o: object) => Promise<Buffer>;
const scrypt = (p: string, s: Buffer, k: number, o: { N: number; r: number; p: number }) =>
  scryptAsync(p, s, k, o);

// The real thing, at real cost - a hash somebody can forge in a test is not the
// hash that is protecting the account.
const hash = (pw: string) => hashPassword(pw, scrypt, randomBytes);
const verify = (pw: string, stored: string) => verifyPassword(pw, stored, scrypt, timingSafeEqual);

describe("hashing", () => {
  it("round-trips a password", async () => {
    const stored = await hash("correct horse battery");
    expect(await verify("correct horse battery", stored)).toBe(true);
    expect(await verify("correct horse batterz", stored)).toBe(false);
  });

  it("never stores the password, and salts every hash differently", async () => {
    const a = await hash("correct horse battery");
    const b = await hash("correct horse battery");
    expect(a).not.toContain("correct");
    // Same password, different stored value: a stolen table can't be grouped by
    // "who else used this password", and one cracked hash cracks one account.
    expect(a).not.toEqual(b);
    expect(await verify("correct horse battery", b)).toBe(true);
  });

  it("carries its own parameters, so they can be raised later", async () => {
    const stored = await hash("correct horse battery");
    expect(stored.startsWith(`scrypt$${SCRYPT_N}$`)).toBe(true);
    expect(parseHash(stored)).toMatchObject({ N: SCRYPT_N });
  });

  it("still verifies a hash made with weaker parameters, and says it is stale", async () => {
    // The upgrade path: an old hash keeps working until the person next signs
    // in, rather than locking them out the day the cost is raised.
    const salt = randomBytes(16);
    const weak = ["scrypt", 1024, 8, 1, salt.toString("base64url"),
      (await scrypt("correct horse battery", salt, 32, { N: 1024, r: 8, p: 1 })).toString("base64url")].join("$");
    expect(await verify("correct horse battery", weak)).toBe(true);
    expect(needsRehash(weak)).toBe(true);
    expect(needsRehash(await hash("correct horse battery"))).toBe(false);
  });

  it("treats the same characters typed two ways as the same password", async () => {
    // é composed vs decomposed: one keyboard produces one, one produces the
    // other, and being locked out by an invisible difference is unforgivable.
    const stored = await hash("café password");
    expect(await verify("café password", stored)).toBe(true);
  });
});

describe("junk in the hash column", () => {
  it("refuses rather than throws", async () => {
    for (const junk of ["", "not-a-hash", "scrypt$x$8$1$aa$bb", "scrypt$16384$8$1$aa", "bcrypt$2$3$aa$bb"]) {
      expect(parseHash(junk)).toBeNull();
      expect(await verify("anything", junk)).toBe(false);
    }
  });

  it("counts an unreadable hash as stale, not as fine", async () => {
    expect(needsRehash("garbage")).toBe(true);
  });
});

describe("what a password has to clear", () => {
  it("asks for length and nothing decorative", () => {
    expect(passwordProblem("x".repeat(MIN_PASSWORD))).toBeNull();
    expect(passwordProblem("short")).toContain(`${MIN_PASSWORD} characters`);
    expect(passwordProblem("          ")).toBe("That's mostly spaces.");
    expect(passwordProblem("x".repeat(201))).toContain("200");
  });

  it("refuses the two guesses anybody would make first", () => {
    expect(passwordProblem("jrharris is here", "jrharris@sierraspectra.com")).toContain("email address");
    expect(passwordProblem("password12345")).toContain("guessable");
    expect(passwordProblem("sierra spectra 1")).toContain("guessable");
  });

  it("ignores a very short email local part rather than banning a common word", () => {
    // "jo" appearing inside a passphrase is not a reason to refuse it.
    expect(passwordProblem("enjoy the silence", "jo@x.com")).toBeNull();
  });
});
