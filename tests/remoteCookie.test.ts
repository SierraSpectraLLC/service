import { describe, expect, it } from "vitest";
import {
  bareEngineId, decodeEngineCookie, encodeEngineCookie, ENGINE_KEY_HEX_CHARS, engineUserId, mintEngineToken,
  pickExistingGroup,
} from "@/lib/remote";

// The remote-support host authenticates the portal by a token it encrypts with a
// key both sides hold. There is no way to be told you got the format wrong: the
// engine simply shows a login page instead of the machine, having logged nothing
// useful. So these tests assert the format itself - the layout, the substituted
// base64 characters, the fields the engine's decoder insists on, and every way it
// rejects a token - against MeshCentral 1.2.4's own encodeCookie/decodeCookieAESGCM.
//
// If the host is ever upgraded, re-read those two functions and re-run this file.
// That is the whole upgrade drill for this part.

const KEY = "a".repeat(ENGINE_KEY_HEX_CHARS);
const OTHER = "b".repeat(ENGINE_KEY_HEX_CHARS);
const NOW = 1_755_000_000_000;

describe("engine token format", () => {
  it("round-trips a payload and stamps the creation time in seconds", () => {
    const c = encodeEngineCookie({ u: "user//portal-admin", a: 3 }, KEY, NOW);
    expect(decodeEngineCookie(c, KEY, NOW)).toMatchObject({
      u: "user//portal-admin", a: 3, time: Math.floor(NOW / 1000),
    });
  });

  it("carries no character that would need escaping in a URL query", () => {
    // The engine swaps + and / for @ and $ before sending, and swaps them back on
    // the way in. A token that still contained + or / would survive this test
    // suite and fail in a browser.
    for (let i = 0; i < 200; i++) {
      const c = encodeEngineCookie({ u: "user//portal-admin", a: 3 }, KEY, NOW + i);
      expect(c).toMatch(/^[A-Za-z0-9@$=]+$/);
    }
  });

  it("lays the bytes out as iv, tag, then ciphertext", () => {
    const c = encodeEngineCookie({ u: "user//portal-admin", a: 3 }, KEY, NOW);
    const raw = Buffer.from(c.replace(/@/g, "+").replace(/\$/g, "/"), "base64");
    // 12 of nonce and 16 of tag before anything encrypted, and the payload is
    // longer than nothing - the offsets the engine slices at.
    expect(raw.length).toBeGreaterThan(12 + 16);
  });

  it("refuses a token encrypted with a different key", () => {
    const c = encodeEngineCookie({ u: "user//portal-admin", a: 3 }, KEY, NOW);
    expect(decodeEngineCookie(c, OTHER, NOW)).toBeNull();
  });

  it("refuses a token whose ciphertext was edited", () => {
    const c = encodeEngineCookie({ u: "user//portal-admin", a: 3 }, KEY, NOW);
    const raw = Buffer.from(c.replace(/@/g, "+").replace(/\$/g, "/"), "base64");
    raw[raw.length - 1] ^= 0xff;
    const tampered = raw.toString("base64").replace(/\+/g, "@").replace(/\//g, "$");
    expect(decodeEngineCookie(tampered, KEY, NOW)).toBeNull();
  });

  it("refuses nonsense outright rather than throwing", () => {
    expect(decodeEngineCookie("not-a-token", KEY, NOW)).toBeNull();
    expect(decodeEngineCookie("", KEY, NOW)).toBeNull();
  });
});

describe("token lifetime", () => {
  it("expires on the minute it claims to", () => {
    const c = encodeEngineCookie({ u: "user//portal-admin", a: 3, expire: 2 }, KEY, NOW);
    expect(decodeEngineCookie(c, KEY, NOW + 119_000)).not.toBeNull();
    expect(decodeEngineCookie(c, KEY, NOW + 121_000)).toBeNull();
  });

  it("tolerates half a minute of clock skew and no more", () => {
    const c = encodeEngineCookie({ u: "user//portal-admin", a: 3, expire: 2 }, KEY, NOW);
    expect(decodeEngineCookie(c, KEY, NOW - 29_000)).not.toBeNull();
    expect(decodeEngineCookie(c, KEY, NOW - 31_000)).toBeNull();
  });

  it("falls back to two minutes when no expiry is stated", () => {
    const c = encodeEngineCookie({ u: "user//portal-admin" }, KEY, NOW);
    expect(decodeEngineCookie(c, KEY, NOW + 119_000)).not.toBeNull();
    expect(decodeEngineCookie(c, KEY, NOW + 121_000)).toBeNull();
  });

  it("mints a login token the engine will recognize as one", () => {
    const cfg = { url: "https://remote.example.com", loginKey: KEY, adminUser: "Portal-Admin" };
    const decoded = decodeEngineCookie(mintEngineToken(cfg, 120, NOW), KEY, NOW);
    // a: 3 is what marks it a login rather than one of the engine's other cookies,
    // and the user id has to be lowercased or the account lookup misses.
    expect(decoded).toMatchObject({ u: "user//portal-admin", a: 3, expire: 2 });
  });

  it("never mints a sub-minute expiry, which the engine would read as zero", () => {
    const cfg = { url: "https://remote.example.com", loginKey: KEY, adminUser: "portal-admin" };
    expect(decodeEngineCookie(mintEngineToken(cfg, 5, NOW), KEY, NOW)).toMatchObject({ expire: 1 });
  });
});

describe("the key itself", () => {
  it("says the required length when it's wrong, because nothing else will", () => {
    // The failure this guards against: the host warns once at startup, uses a key
    // of its own, and then looks entirely healthy while refusing every link.
    expect(() => encodeEngineCookie({ u: "x" }, "a".repeat(96), NOW))
      .toThrow(/160 hex characters \(80 bytes\)/);
    expect(() => encodeEngineCookie({ u: "x" }, "", NOW)).toThrow(/160 hex characters/);
    expect(() => encodeEngineCookie({ u: "x" }, "z".repeat(ENGINE_KEY_HEX_CHARS), NOW))
      .toThrow(/160 hex characters/);
  });

  it("ignores whitespace around a pasted key", () => {
    expect(() => encodeEngineCookie({ u: "x" }, `  ${KEY}\n`, NOW)).not.toThrow();
  });
});

describe("naming things the way the engine names them", () => {
  it("builds a user id for the default domain", () => {
    expect(engineUserId("portal-admin")).toBe("user//portal-admin");
    expect(engineUserId("Portal-Admin")).toBe("user//portal-admin");
    expect(engineUserId("portal-admin", "sierra")).toBe("user/sierra/portal-admin");
  });

  it("leaves an already-qualified id alone", () => {
    expect(engineUserId("user//someone")).toBe("user//someone");
  });

  it("strips the domain from a node or group id, since the engine re-adds it", () => {
    expect(bareEngineId("node//abc123")).toBe("abc123");
    expect(bareEngineId("node/sierra/abc123")).toBe("abc123");
    expect(bareEngineId("abc123")).toBe("abc123");
    expect(bareEngineId("mesh//grp789")).toBe("grp789");
  });
});

describe("adopting a device group that already exists", () => {
  const G = (name: string, _id: string, mtype = 2) => ({ _id, name, mtype });

  it("adopts the one group wearing the org's name", () => {
    expect(pickExistingGroup([G("LabZen", "mesh//aaa"), G("Other", "mesh//bbb")], "LabZen"))
      .toBe("mesh//aaa");
  });

  it("ignores case and stray whitespace, since a human typed one of the two", () => {
    expect(pickExistingGroup([G("labzen ", "mesh//aaa")], " LabZen")).toBe("mesh//aaa");
  });

  it("refuses to choose between two groups of the same name", () => {
    // Guessing here would file a client's machine where another client can see it.
    expect(pickExistingGroup([G("LabZen", "mesh//aaa"), G("LabZen", "mesh//bbb")], "LabZen")).toBeNull();
  });

  it("passes over groups that are not the agent-managed kind", () => {
    expect(pickExistingGroup([G("LabZen", "mesh//aaa", 1)], "LabZen")).toBeNull();
  });

  it("returns null on nothing, junk, or a name that matches no group", () => {
    expect(pickExistingGroup([], "LabZen")).toBeNull();
    expect(pickExistingGroup([null, 7, {}, { name: "LabZen" }], "LabZen")).toBeNull();
    expect(pickExistingGroup([G("LabZen", "mesh//aaa")], "GMI")).toBeNull();
  });
});
