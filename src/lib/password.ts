// Passwords, for the days the email doesn't arrive.
//
// The portal signs people in by email - a link, or a six-digit code. Both stop
// working the moment mail does: a provider rate-limits a domain, a filter eats
// the message, a fourteen-day block lands on an address for reasons nobody
// explains. When that happens there is no way in at all, and "no way in" to the
// system that tracks the instruments is worse than any of the risks below.
//
// So: a password, as the fallback and not the front door. Set from inside the
// app by somebody already signed in, which means the address was proved first,
// and it is the reason this is safe to offer at all - nobody can bootstrap an
// account with it.
//
// scrypt rather than bcrypt or argon2, because those are native modules and this
// runs on a serverless platform where a native module is a deployment problem
// waiting to happen. Node ships scrypt; it is memory-hard; the parameters below
// are the published defaults scaled up, and they are stored WITH the hash so
// raising them later doesn't invalidate everybody's password.
//
// The stored form is `scrypt$N$r$p$salt$hash`, all base64url. Reading a hash out
// of the database tells you how to check it and nothing else.

export const SCRYPT_N = 16384;   // CPU/memory cost
export const SCRYPT_R = 8;       // block size
export const SCRYPT_P = 1;       // parallelism
export const SALT_BYTES = 16;
export const KEY_BYTES = 32;

/** Nothing shorter. Length is the only thing a rule can honestly ask for. */
export const MIN_PASSWORD = 10;

export type ScryptFn = (password: string, salt: Buffer, keylen: number, opts: {
  N: number; r: number; p: number;
}) => Promise<Buffer>;

const b64 = (b: Buffer) => b.toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url");

/**
 * What a password has to clear. Deliberately just length and "not obviously
 * this app": composition rules (a digit! a symbol!) buy far less than length and
 * push people toward Passw0rd! - and toward writing it on the monitor, which is
 * the exact thing this whole product replaces for remote access.
 */
export function passwordProblem(password: string, email = ""): string | null {
  const p = password ?? "";
  if (p.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (p.length > 200) return "That's longer than 200 characters.";
  if (p.trim().length < MIN_PASSWORD) return "That's mostly spaces.";
  const local = email.split("@")[0]?.toLowerCase() ?? "";
  if (local.length >= 4 && p.toLowerCase().includes(local)) return "Don't use your email address in it.";
  if (/^(?:password|baseline|sierra|instrument)/i.test(p)) return "Pick something less guessable.";
  return null;
}

/** Hash a password for storage. The parameters ride along with it. */
export async function hashPassword(
  password: string, scrypt: ScryptFn, randomBytes: (n: number) => Buffer,
): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scrypt(password.normalize("NFKC"), salt, KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P, b64(salt), b64(key)].join("$");
}

export type StoredHash = { N: number; r: number; p: number; salt: Buffer; key: Buffer };

/** Read a stored hash, or null if it is not one. Never throws on junk. */
export function parseHash(stored: string): StoredHash | null {
  const parts = (stored ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [, n, r, p, salt, key] = parts;
  const nums = [Number(n), Number(r), Number(p)];
  if (nums.some((x) => !Number.isInteger(x) || x <= 0)) return null;
  try {
    const s = unb64(salt), k = unb64(key);
    if (!s.length || !k.length) return null;
    return { N: nums[0], r: nums[1], p: nums[2], salt: s, key: k };
  } catch {
    return null;
  }
}

/**
 * Does this password match the stored hash?
 *
 * The comparison is constant-time. That matters less here than in a token check -
 * an attacker gets six guesses before the address locks - but a timing-safe
 * compare costs one function call, and reaching for the cheap `===` in an auth
 * path is a habit worth not having.
 */
export async function verifyPassword(
  password: string, stored: string, scrypt: ScryptFn,
  timingSafeEqual: (a: Buffer, b: Buffer) => boolean,
): Promise<boolean> {
  const h = parseHash(stored);
  if (!h) return false;
  const key = await scrypt(password.normalize("NFKC"), h.salt, h.key.length, { N: h.N, r: h.r, p: h.p });
  return key.length === h.key.length && timingSafeEqual(key, h.key);
}

/** Was this hash made with weaker parameters than we use now? */
export const needsRehash = (stored: string): boolean => {
  const h = parseHash(stored);
  return !h || h.N < SCRYPT_N || h.r < SCRYPT_R || h.p < SCRYPT_P;
};
