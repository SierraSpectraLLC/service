import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authorizeUrl, graphBaseUrl, graphConfig, graphConfigured, graphSetupProblem, pkcePair, SCOPES,
} from "@/lib/msgraph";
import { createHash } from "node:crypto";

const env = { ...process.env };
beforeEach(() => {
  process.env.MS_CLIENT_ID = "client-abc";
  process.env.MS_CLIENT_SECRET = "shhh";
  process.env.APP_URL = "https://service.example.com/";
});
afterEach(() => { process.env = { ...env }; });

describe("whether this instance can talk to Microsoft at all", () => {
  it("needs an id, a secret and somewhere to come back to", () => {
    expect(graphConfigured()).toBe(true);
    for (const missing of ["MS_CLIENT_ID", "MS_CLIENT_SECRET", "APP_URL"]) {
      const kept = process.env[missing];
      delete process.env[missing];
      if (missing === "APP_URL") delete process.env.AUTH_URL;
      expect(graphConfigured()).toBe(false);
      process.env[missing] = kept;
    }
  });

  it("builds the redirect off the app's own address, trailing slash or not", () => {
    expect(graphConfig()?.redirectUri).toBe("https://service.example.com/api/cloud/callback");
  });

  it("finds the app's address the way the rest of the app does", () => {
    // The bug this closes: OneDrive derived its own base URL instead of using
    // the shared appUrl(), so an instance with every Microsoft variable set and
    // no APP_URL had the whole feature silently disappear.
    delete process.env.APP_URL;
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "service.vercel.app";
    expect(graphBaseUrl()).toBe("https://service.vercel.app");
    expect(graphConfigured()).toBe(true);
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    process.env.AUTH_URL = "https://fallback.example.com/";
    expect(graphBaseUrl()).toBe("https://fallback.example.com");
  });

  it("defaults to any tenant, so a client's own OneDrive can connect", () => {
    // Pinned to one tenant, only this company's accounts could ever sign in -
    // which would quietly make the feature useless for exactly the case Bill
    // asked about.
    expect(graphConfig()?.tenant).toBe("common");
    process.env.MS_TENANT = "1234-abcd";
    expect(graphConfig()?.tenant).toBe("1234-abcd");
  });
});

describe("PKCE", () => {
  it("hands out the hash and keeps the secret", () => {
    const { verifier, challenge } = pkcePair();
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
    expect(challenge).not.toBe(verifier);
  });

  it("is different every time", () => {
    expect(pkcePair().verifier).not.toBe(pkcePair().verifier);
  });

  it("is URL-safe, so it survives a query string unescaped", () => {
    const { verifier, challenge } = pkcePair();
    for (const s of [verifier, challenge]) expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("where somebody is sent to approve this", () => {
  const url = () => new URL(authorizeUrl(graphConfig()!, "state-123", "challenge-abc"));

  it("carries the app, the way back, and the state", () => {
    const q = url().searchParams;
    expect(q.get("client_id")).toBe("client-abc");
    expect(q.get("redirect_uri")).toBe("https://service.example.com/api/cloud/callback");
    expect(q.get("state")).toBe("state-123");
    expect(q.get("response_type")).toBe("code");
  });

  it("carries the PKCE challenge and never the verifier", () => {
    const q = url().searchParams;
    expect(q.get("code_challenge")).toBe("challenge-abc");
    expect(q.get("code_challenge_method")).toBe("S256");
  });

  it("asks for offline access, or the connection dies with the browser tab", () => {
    expect(url().searchParams.get("scope")?.split(" ")).toContain("offline_access");
    expect(SCOPES).toContain("Files.ReadWrite.All");
  });

  it("asks which account, rather than silently taking the last one used", () => {
    expect(url().searchParams.get("prompt")).toBe("select_account");
  });

  it("never puts the client secret in a URL somebody's browser will follow", () => {
    expect(authorizeUrl(graphConfig()!, "s", "c")).not.toContain("shhh");
  });
});

describe("saying why OneDrive is not working", () => {
  it("says nothing when it is", () => {
    expect(graphSetupProblem()).toBe("");
  });

  it("names the Microsoft variables that are missing", () => {
    // A capability that hides its own misconfiguration cannot be set up by
    // anybody but the person who wrote it.
    delete process.env.MS_CLIENT_ID;
    expect(graphSetupProblem()).toContain("MS_CLIENT_ID");
    delete process.env.MS_CLIENT_SECRET;
    expect(graphSetupProblem()).toContain("MS_CLIENT_ID and MS_CLIENT_SECRET");
  });

  it("names the address when that is the only thing missing", () => {
    delete process.env.APP_URL;
    delete process.env.AUTH_URL;
    delete process.env.NEXTAUTH_URL;
    delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
    expect(graphSetupProblem()).toContain("APP_URL");
  });
});
