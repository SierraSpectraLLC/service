import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authorizeUrl, graphBaseUrl, graphConfig, graphConfigured, graphSetupProblem, listFolder, listPlaces,
  missingScopes, pkcePair, searchFiles, SCOPES, SHARED_DRIVE,
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

  it("asks to see which teams somebody is in", () => {
    // Without it the one place a shop actually keeps its documents - the
    // SharePoint library behind its Team - is invisible to this browser.
    expect(SCOPES).toContain("Team.ReadBasic.All");
  });

  it("asks which account, rather than silently taking the last one used", () => {
    expect(url().searchParams.get("prompt")).toBe("select_account");
  });

  it("never puts the client secret in a URL somebody's browser will follow", () => {
    expect(authorizeUrl(graphConfig()!, "s", "c")).not.toContain("shhh");
  });
});

describe("a connection made before a scope was added", () => {
  it("spots the scope nobody ever approved", () => {
    expect(missingScopes("openid profile User.Read Files.ReadWrite.All Sites.Read.All offline_access"))
      .toEqual(["Team.ReadBasic.All"]);
  });

  it("is satisfied by the scopes it was given, however Microsoft spells them", () => {
    // Echoed back short in one tenant and fully qualified in another; both mean
    // the same grant, and treating the second as missing would tell somebody
    // with a perfectly good connection to make it again.
    const full = SCOPES.filter((s) => s.includes("."))
      .map((s) => `https://graph.microsoft.com/${s}`).join(" ");
    expect(missingScopes(full)).toEqual([]);
    expect(missingScopes(SCOPES.join(" "))).toEqual([]);
  });

  it("says nothing when the token response never listed any", () => {
    // Silence is not evidence. Reading a blank scope string as "nothing was
    // granted" would break every working connection at once.
    expect(missingScopes("")).toEqual([]);
  });
});

describe("which store gets read", () => {
  // Graph's URL shapes are the part of this file that is easy to get wrong and
  // impossible to see wrong: a bad path answers 400 and the browser shows an
  // empty folder. These stub fetch and assert on the URL that would have gone out.
  const asked: string[] = [];
  const answers = new Map<RegExp, unknown>();
  const realFetch = global.fetch;

  beforeEach(() => {
    asked.length = 0;
    answers.clear();
    global.fetch = (async (url: string) => {
      asked.push(String(url));
      const hit = [...answers].find(([re]) => re.test(String(url)));
      return {
        ok: true, status: 200,
        json: async () => (hit ? hit[1] : { value: [] }),
      };
    }) as unknown as typeof fetch;
  });
  afterEach(() => { global.fetch = realFetch; });

  it("addresses a drive's top folder as root, not as an item called root", async () => {
    // `/items/root` is not a thing Graph accepts. Getting this wrong broke every
    // drive except the signed-in person's own - which is every Team.
    await listFolder("tok", "team-drive", "root");
    expect(asked[0]).toContain("/drives/team-drive/root/children");
    expect(asked[0]).not.toContain("/items/root");
  });

  it("addresses everything below the top by id", async () => {
    await listFolder("tok", "team-drive", "01ABCDEF");
    expect(asked[0]).toContain("/drives/team-drive/items/01ABCDEF/children");
  });

  it("reads shared items from their own list, since they are children of nothing", async () => {
    await listFolder("tok", SHARED_DRIVE, "root");
    expect(asked[0]).toContain("/me/drive/sharedWithMe");
  });

  it("searches the store somebody is standing in", async () => {
    await searchFiles("tok", "tune report", "team-drive");
    expect(asked[0]).toContain("/drives/team-drive/root/search(q='tune%20report')");
  });

  it("searches the personal drive when there is no real drive to scope to", async () => {
    await searchFiles("tok", "tune", SHARED_DRIVE);
    expect(asked[0]).toContain("/me/drive/root/search");
  });

  it("offers the personal drive, shared items, and every team", async () => {
    answers.set(/joinedTeams/, { value: [{ id: "t1", displayName: "Sierra Spectra" }] });
    answers.set(/groups\/t1\/drive/, { id: "sharepoint-drive" });
    const { items } = await listPlaces("tok");
    expect(items?.map((i) => i.name)).toEqual(["My files", "Shared with me", "Sierra Spectra"]);
    expect(items?.[2]).toMatchObject({ id: "root", driveId: "sharepoint-drive", isFolder: true });
  });

  it("still shows somebody their own files when the tenant will not answer for teams", async () => {
    // A tenant that refuses the teams call, or a team with no library, must not
    // take the whole browser down with it.
    answers.set(/joinedTeams/, { value: [{ id: "t1", displayName: "Sierra Spectra" }] });
    answers.set(/groups\/t1\/drive/, {});
    const { items } = await listPlaces("tok");
    expect(items?.map((i) => i.name)).toEqual(["My files", "Shared with me"]);
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
