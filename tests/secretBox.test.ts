import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { open, readable, sameSecret, seal, vaultConfigured, VAULT_UNCONFIGURED } from "@/lib/secretBox";

const KEY = "a".repeat(40);
const OTHER = "b".repeat(40);

beforeEach(() => { process.env.CLOUD_TOKEN_KEY = KEY; });
afterEach(() => { delete process.env.CLOUD_TOKEN_KEY; });

describe("keeping somebody else's credential", () => {
  it("comes back exactly as it went in", () => {
    const token = "0.AXoA...a-real-looking-refresh-token_-~";
    expect(open(seal(token))).toBe(token);
  });

  it("seals the same secret differently every time", () => {
    // A fresh IV per seal, so two rows holding the same token do not look alike
    // to somebody reading the table.
    expect(seal("same")).not.toBe(seal("same"));
  });

  it("refuses to store anything at all without a key", () => {
    // The failure that matters: quietly writing the token in the clear because
    // the environment was misconfigured.
    delete process.env.CLOUD_TOKEN_KEY;
    expect(vaultConfigured()).toBe(false);
    expect(() => seal("secret")).toThrow(VAULT_UNCONFIGURED);
  });

  it("will not accept a key short enough to remember", () => {
    process.env.CLOUD_TOKEN_KEY = "hunter2";
    expect(vaultConfigured()).toBe(false);
  });
});

describe("what a damaged or foreign value opens to", () => {
  const sealed = (() => { process.env.CLOUD_TOKEN_KEY = KEY; return seal("the token"); })();

  it("is nothing, under a different key", () => {
    process.env.CLOUD_TOKEN_KEY = OTHER;
    expect(open(sealed)).toBeNull();
    expect(readable(sealed)).toBe(false);
  });

  it("is nothing, when a byte was changed", () => {
    // GCM's whole point: a flipped bit is caught rather than decrypted into
    // plausible-looking garbage that gets sent to Microsoft.
    const parts = sealed.split(".");
    const body = Buffer.from(parts[3], "base64url");
    body[0] ^= 0xff;
    expect(open([parts[0], parts[1], parts[2], body.toString("base64url")].join("."))).toBeNull();
  });

  it("is nothing, for junk, a blank, or a version we do not know", () => {
    for (const bad of ["", "nonsense", "v1.a.b", "v9." + sealed.split(".").slice(1).join("."), null, undefined]) {
      expect(open(bad as string)).toBeNull();
    }
  });

  it("is nothing when the server has no key, rather than throwing mid-render", () => {
    delete process.env.CLOUD_TOKEN_KEY;
    expect(open(sealed)).toBeNull();
  });
});

describe("checking the OAuth state", () => {
  it("matches only an exact value", () => {
    expect(sameSecret("abc123", "abc123")).toBe(true);
    expect(sameSecret("abc123", "abc124")).toBe(false);
    expect(sameSecret("abc123", "abc1234")).toBe(false);
  });

  it("never lets an empty state match an empty state", () => {
    // Otherwise a request that simply omits the parameter passes the check.
    expect(sameSecret("", "")).toBe(false);
  });
});
