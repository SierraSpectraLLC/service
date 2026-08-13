// Somewhere to keep a credential that belongs to somebody else.
//
// A Microsoft refresh token is a standing key to a person's OneDrive. It is not
// ours, it does not expire on its own, and a database backup that leaks one is a
// far worse day than a leaked row of instrument data. So it never goes in a
// column as text: it is sealed with a key that lives only in the environment,
// which means a copy of the database on its own opens nothing.
//
// AES-256-GCM, so tampering is detected rather than decrypted into garbage. The
// stored form carries a version prefix because the one certain thing about a key
// is that it will need rotating, and a format that cannot say which key sealed
// it can only be rotated by throwing every token away.

import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
const VERSION = "v1";

/**
 * The sealing key. A passphrase of any length is hashed to 32 bytes rather than
 * being length-checked, so an operator can use a long random string without
 * having to count characters - but a short one is refused, because a key that
 * fits in a person's head is not a key.
 */
function sealingKey(): Buffer | null {
  const raw = process.env.CLOUD_TOKEN_KEY ?? "";
  if (raw.length < 32) return null;
  return createHash("sha256").update(raw, "utf8").digest();
}

/** True when this instance can hold third-party credentials at all. */
export const vaultConfigured = () => sealingKey() !== null;

/** The message a caller shows when it is not. Never "an error occurred". */
export const VAULT_UNCONFIGURED =
  "This instance has no CLOUD_TOKEN_KEY set, so it cannot store a connection to an outside account.";

/**
 * Seal a secret for storage. Throws rather than returning a fallback: silently
 * storing a token in the clear because a key was missing is the one outcome this
 * module exists to prevent.
 */
export function seal(plain: string): string {
  const key = sealingKey();
  if (!key) throw new Error(VAULT_UNCONFIGURED);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv, cipher.getAuthTag(), body]
    .map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

/**
 * Open a sealed secret, or null.
 *
 * Null covers every way this can fail - the wrong key, a truncated column, a
 * value somebody edited by hand, a version we no longer understand - because to
 * a caller they mean the same thing: this connection has to be made again. None
 * of them is worth a stack trace in a page render.
 */
export function open(sealed: string | null | undefined): string | null {
  const key = sealingKey();
  if (!key || !sealed) return null;
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) return null;
  try {
    const [, iv, tag, body] = parts.map((p, i) => (i === 0 ? p : Buffer.from(p, "base64url"))) as
      [string, Buffer, Buffer, Buffer];
    if (iv.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return decipher.update(body, undefined, "utf8") + decipher.final("utf8");
  } catch {
    return null;
  }
}

/**
 * Is this sealed value still readable with the key this instance holds?
 *
 * Used to tell "your connection expired" from "this server cannot read its own
 * vault", which are the same symptom and completely different fixes.
 */
export const readable = (sealed: string | null | undefined) => open(sealed) !== null;

/**
 * Constant-time compare for the OAuth state parameter.
 *
 * The state is what stops somebody handing this app an authorization code they
 * obtained elsewhere, so it is a secret being checked, and `!==` on a secret is
 * a habit worth not having. Length is compared first because timingSafeEqual
 * throws on a mismatch - length is not the part worth hiding.
 */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
