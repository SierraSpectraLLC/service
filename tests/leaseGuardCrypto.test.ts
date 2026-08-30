import { describe, expect, it } from "vitest";
import {
  deriveMachineSecret, generateLeaseKeypair, generateMasterSecret,
  offlineUnlockCode, signLease, signRelease, verifyLease, verifyRelease, verifyUnlockCode,
} from "@/lib/leaseGuardCrypto";

const keys = generateLeaseKeypair();
const other = generateLeaseKeypair();

describe("a signed lease the machine can trust offline", () => {
  const payload = { machineId: "node//abc", expiresAt: 1_800_000_000_000, counter: 4 };

  it("round-trips through the public key", () => {
    const token = signLease(keys.privateKeyB64, payload);
    expect(verifyLease(keys.publicKeyB64, token)).toEqual(payload);
  });

  it("is rejected once a single field is altered", () => {
    const token = signLease(keys.privateKeyB64, payload);
    const [body, sig] = token.split(".");
    // Re-sign nothing; just swap the body for a different expiry. Signature no
    // longer matches, which is the whole guarantee a thief cannot beat.
    const forged = Buffer.from("lease-v1|node//abc|9999999999999|4").toString("base64url") + "." + sig;
    expect(verifyLease(keys.publicKeyB64, forged)).toBeNull();
    expect(body).toBeTruthy();
  });

  it("is rejected under a different key - only our private key issues leases", () => {
    const token = signLease(other.privateKeyB64, payload);
    expect(verifyLease(keys.publicKeyB64, token)).toBeNull();
  });

  it("returns null on garbage rather than throwing", () => {
    expect(verifyLease(keys.publicKeyB64, "not-a-token")).toBeNull();
    expect(verifyLease(keys.publicKeyB64, "")).toBeNull();
  });
});

describe("the permanent release", () => {
  it("verifies for the machine it names and no other", () => {
    const token = signRelease(keys.privateKeyB64, "node//abc");
    expect(verifyRelease(keys.publicKeyB64, "node//abc", token)).toBe(true);
    // A release captured off one machine does not release another.
    expect(verifyRelease(keys.publicKeyB64, "node//xyz", token)).toBe(false);
  });
  it("cannot be forged without our private key", () => {
    const token = signRelease(other.privateKeyB64, "node//abc");
    expect(verifyRelease(keys.publicKeyB64, "node//abc", token)).toBe(false);
  });
});

describe("the offline unlock code an engineer reads aloud", () => {
  const master = generateMasterSecret();
  const secret = deriveMachineSecret(master, "node//abc");

  it("is twelve digits", () => {
    expect(offlineUnlockCode(secret, 7)).toMatch(/^\d{12}$/);
  });

  it("verifies for its counter and rejects any other", () => {
    const code = offlineUnlockCode(secret, 7);
    expect(verifyUnlockCode(secret, 7, code)).toBe(true);
    // The counter advances when a code is accepted, so the same digits are dead
    // on the next counter - no replay.
    expect(verifyUnlockCode(secret, 8, code)).toBe(false);
  });

  it("tolerates the spaces and dashes a person types", () => {
    const code = offlineUnlockCode(secret, 7);
    const spaced = `${code.slice(0, 4)} ${code.slice(4, 8)}-${code.slice(8)}`;
    expect(verifyUnlockCode(secret, 7, spaced)).toBe(true);
  });

  it("is per-machine: a secret from one node does not unlock another", () => {
    const secretB = deriveMachineSecret(master, "node//xyz");
    const code = offlineUnlockCode(secret, 7);
    expect(verifyUnlockCode(secretB, 7, code)).toBe(false);
  });

  it("needs the master secret - a guessed secret does not match", () => {
    const wrong = deriveMachineSecret(generateMasterSecret(), "node//abc");
    expect(verifyUnlockCode(wrong, 7, offlineUnlockCode(secret, 7))).toBe(false);
  });
});
