// The signatures the guard verifies with no network, and the code an engineer
// reads over a phone. Server-only: it holds the private key, the machine holds
// only what it needs to CHECK a signature, never to make one.
//
// Read against the same constraint the rest of the remote stack is: the guard
// runs on a machine we do not control and must assume we cannot keep a secret
// on. So the two paths here are shaped by who holds what.
//
// ── Two paths, because one is typed by a human ──────────────────────────────
//
//   * A LEASE and a RELEASE are Ed25519 signatures. We hold the private key;
//     the guard embeds the public key and only verifies. Nothing on the machine
//     can forge either, even pulled apart with admin rights. A release is typed
//     once in a system's life, so its 88 characters cost nothing.
//
//   * An OFFLINE UNLOCK CODE is a truncated HMAC. To verify a code with no
//     network the guard must hold a verifier, and anything it holds an admin
//     can read - so this path is only as strong as the throttling the guard
//     puts in front of it. Twelve digits is a space of 10^12: fine against a
//     person reading numbers off a screen, guessable by a script, which is why
//     the guard must rate-limit attempts itself. Used only when there is no
//     network at all; the Ed25519 lease is the everyday path.
import { createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign, verify } from "node:crypto";

/** What a signed lease says. No money, same as lib/leaseGuard - only identity and time. */
export type LeasePayload = {
  /** The machine this lease is for. A lease for one node is worthless on another. */
  machineId: string;
  /** Unix ms. The guard compares against its own clock; lib/leaseGuard decides grace. */
  expiresAt: number;
  /** Monotonic. The guard refuses a token whose counter is below the last it saw, so a captured older lease cannot be replayed to roll the clock back. */
  counter: number;
};

const b64url = (b: Buffer) => b.toString("base64url");

/**
 * Generate a lease keypair, for provisioning. The private half becomes
 * LEASE_SIGNING_KEY on our side; the public half is baked into the guard. Both
 * are base64 DER so they survive an env var and a build config without newlines.
 */
export function generateLeaseKeypair(): { privateKeyB64: string; publicKeyB64: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyB64: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
    publicKeyB64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}

const privFrom = (b64: string) => createPrivateKey({ key: Buffer.from(b64, "base64"), format: "der", type: "pkcs8" });
const pubFrom = (b64: string) => createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });

/** Canonical bytes for a payload - key order fixed, so signer and verifier agree. */
function leaseBytes(p: LeasePayload): Buffer {
  return Buffer.from(`lease-v1|${p.machineId}|${p.expiresAt}|${p.counter}`, "utf8");
}

/** A signed lease token: `body.signature`, both base64url. */
export function signLease(privateKeyB64: string, p: LeasePayload): string {
  const body = b64url(leaseBytes(p));
  const sig = b64url(sign(null, leaseBytes(p), privFrom(privateKeyB64)));
  return `${body}.${sig}`;
}

/** Verify and parse a lease token, or null if it is forged, altered, or malformed. */
export function verifyLease(publicKeyB64: string, token: string): LeasePayload | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  let raw: string;
  try { raw = Buffer.from(body, "base64url").toString("utf8"); } catch { return null; }
  const m = /^lease-v1\|(.+)\|(\d+)\|(\d+)$/.exec(raw);
  if (!m) return null;
  const p: LeasePayload = { machineId: m[1], expiresAt: Number(m[2]), counter: Number(m[3]) };
  let ok = false;
  try { ok = verify(null, leaseBytes(p), pubFrom(publicKeyB64), Buffer.from(sig, "base64url")); } catch { return null; }
  return ok ? p : null;
}

/**
 * The permanent release, typed once at sign-off. A signature over the machine
 * id and the word `released` - the guard verifies it, writes its terminal
 * marker, and uninstalls. There is no matching "un-release": a system signed
 * off to its owner is theirs, and nothing here may reach back into it.
 */
export function signRelease(privateKeyB64: string, machineId: string): string {
  return b64url(sign(null, Buffer.from(`release-v1|${machineId}`, "utf8"), privFrom(privateKeyB64)));
}

export function verifyRelease(publicKeyB64: string, machineId: string, token: string): boolean {
  try {
    return verify(null, Buffer.from(`release-v1|${machineId}`, "utf8"), pubFrom(publicKeyB64), Buffer.from(token, "base64url"));
  } catch { return false; }
}

// ── The offline unlock path ─────────────────────────────────────────────────

/**
 * A per-machine secret, derived once from one master secret and the machine id.
 * The guard stores this, not the master: a secret prised off one machine
 * unlocks only that machine. LEASE_MASTER_SECRET never leaves our side.
 */
export function deriveMachineSecret(masterSecretB64: string, machineId: string): string {
  const master = Buffer.from(masterSecretB64, "base64");
  const out = hkdfSync("sha256", master, Buffer.from(machineId, "utf8"), Buffer.from("lease-guard-v1"), 32);
  return Buffer.from(out).toString("base64");
}

/** A fresh master secret, for first-time setup. */
export function generateMasterSecret(): string {
  return randomBytes(32).toString("base64");
}

/**
 * The 12-digit code that extends a lease with no network in the loop.
 *
 * Bound to the machine's per-machine secret AND the counter it is currently on,
 * so a code is good for exactly one extension of exactly one machine: the guard
 * advances its counter when it accepts one, and the same digits will not work
 * twice. The engineer reads the guard's counter aloud, we compute this, they
 * type it back.
 */
export function offlineUnlockCode(machineSecretB64: string, counter: number): string {
  const mac = createHmac("sha256", Buffer.from(machineSecretB64, "base64"))
    .update(`unlock-v1|${counter}`).digest();
  const a = (mac.readUInt32BE(0) % 1_000_000_000).toString().padStart(9, "0");
  const b = (mac.readUInt32BE(4) % 1000).toString().padStart(3, "0");
  return a + b;
}

/**
 * Check a code the way the guard does. Constant-ish comparison on a 12-char
 * string; the real defence against guessing is the guard's own attempt
 * throttling, which this cannot provide and the guard must.
 */
export function verifyUnlockCode(machineSecretB64: string, counter: number, code: string): boolean {
  const want = offlineUnlockCode(machineSecretB64, counter);
  const got = code.replace(/\D/g, "");
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}
