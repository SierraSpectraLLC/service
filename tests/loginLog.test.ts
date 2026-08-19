import { describe, expect, it } from "vitest";
import {
  ACTIVE_DAYS, QUIET_DAYS, daysAgo, rollup, shortAgent, sinceWords, statusOf, usageSummary,
} from "../src/lib/loginLog";

const NOW = new Date("2026-08-19T12:00:00Z");
const ago = (days: number) => daysAgo(NOW, days);
const ev = (email: string, days: number, method = "code", extra: Record<string, unknown> = {}) =>
  ({ email, method, createdAt: ago(days), ...extra });

describe("shortAgent", () => {
  it("names the machine, not the vendor boilerplate", () => {
    expect(shortAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe("iPhone");
    expect(shortAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("Mac");
    expect(shortAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("Windows");
    expect(shortAgent("Mozilla/5.0 (Linux; Android 14; Pixel 8)")).toBe("Android");
  });
  it("iPad is not an iPhone, and an unknown agent says nothing rather than guessing", () => {
    expect(shortAgent("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)")).toBe("iPad");
    expect(shortAgent("curl/8.4.0")).toBe("");
    expect(shortAgent("")).toBe("");
  });
});

describe("sinceWords", () => {
  it("counts in the unit a person would use", () => {
    expect(sinceWords(null, NOW)).toBe("never");
    expect(sinceWords(new Date(NOW.getTime() - 30_000), NOW)).toBe("just now");
    expect(sinceWords(new Date(NOW.getTime() - 20 * 60_000), NOW)).toBe("20 min ago");
    expect(sinceWords(new Date(NOW.getTime() - 5 * 3600_000), NOW)).toBe("5 hours ago");
    expect(sinceWords(ago(1), NOW)).toBe("yesterday");
    expect(sinceWords(ago(12), NOW)).toBe("12 days ago");
    expect(sinceWords(ago(90), NOW)).toBe("3 months ago");
  });
});

describe("statusOf", () => {
  it("takes the later of the two signals", () => {
    // Signed in months ago, but had the portal open this morning: active.
    expect(statusOf(ago(1), ago(60), NOW)).toBe("active");
    // Signed in this morning on a new laptop, session elsewhere is stale.
    expect(statusOf(ago(60), ago(1), NOW)).toBe("active");
  });
  it("grades quiet and dormant by the published windows", () => {
    expect(statusOf(ago(ACTIVE_DAYS + 1), null, NOW)).toBe("quiet");
    expect(statusOf(ago(QUIET_DAYS + 1), null, NOW)).toBe("dormant");
    expect(statusOf(null, null, NOW)).toBe("never");
  });
});

describe("rollup", () => {
  it("joins accounts to events case-blind on the email", () => {
    const rows = rollup(
      [{ email: "Joe@Sierra.com", name: "Joe", lastSeenAt: ago(1) }],
      [ev("joe@sierra.com", 2), ev("JOE@sierra.com", 40)],
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].logins30).toBe(1);
    expect(rows[0].name).toBe("Joe");
  });

  it("counts sign-ins in both windows and names the doors used, most first", () => {
    const rows = rollup(
      [{ email: "a@x.com" }],
      [ev("a@x.com", 1, "password"), ev("a@x.com", 3, "password"), ev("a@x.com", 20, "code")],
      NOW,
    );
    expect(rows[0].logins7).toBe(2);
    expect(rows[0].logins30).toBe(3);
    expect(rows[0].methods).toEqual(["password", "code"]);
  });

  it("a daily user who signs in twice a year is active, not dormant", () => {
    // The whole reason last-seen exists: sessions last a month.
    const rows = rollup([{ email: "a@x.com", lastSeenAt: ago(0) }], [ev("a@x.com", 100)], NOW);
    expect(rows[0].status).toBe("active");
    expect(rows[0].logins30).toBe(0);
  });

  it("somebody given access who never used it is flagged, and stops being flagged once they do", () => {
    const invited = rollup([{ email: "new@client.com", onboardedAt: null }], [], NOW);
    expect(invited[0].status).toBe("never");
    expect(invited[0].invitedNeverIn).toBe(true);

    const arrived = rollup([{ email: "new@client.com", onboardedAt: null }], [ev("new@client.com", 1)], NOW);
    expect(arrived[0].invitedNeverIn).toBe(false);
    expect(arrived[0].status).toBe("active");
  });

  it("keeps a login whose account is gone - history outlives the person", () => {
    const rows = rollup([], [ev("left@sierra.com", 5, "code", { orgName: "Acme", role: "staff" })], NOW);
    expect(rows[0].email).toBe("left@sierra.com");
    expect(rows[0].orgName).toBe("Acme");
    expect(rows[0].role).toBe("staff");
  });

  it("sorts by who was here most recently, never-here last", () => {
    const rows = rollup(
      [{ email: "old@x.com", lastSeenAt: ago(50) }, { email: "never@x.com" }, { email: "fresh@x.com", lastSeenAt: ago(1) }],
      [],
      NOW,
    );
    expect(rows.map((r) => r.email)).toEqual(["fresh@x.com", "old@x.com", "never@x.com"]);
  });

  it("the account's own details win over whatever an old event recorded", () => {
    // Promoted since: January's login must not rewrite who they are today.
    const rows = rollup(
      [{ email: "a@x.com", role: "owner", orgName: "Sierra" }],
      [ev("a@x.com", 90, "code", { role: "client_viewer", orgName: "Old Co" })],
      NOW,
    );
    expect(rows[0].role).toBe("owner");
    expect(rows[0].orgName).toBe("Sierra");
  });
});

describe("usageSummary", () => {
  it("counts each bucket and the week's sign-ins", () => {
    const rows = rollup(
      [
        { email: "a@x.com", lastSeenAt: ago(1) },
        { email: "b@x.com", lastSeenAt: ago(10) },
        { email: "c@x.com", lastSeenAt: ago(90) },
        { email: "d@x.com" },
      ],
      [ev("a@x.com", 1), ev("a@x.com", 2)],
      NOW,
    );
    expect(usageSummary(rows)).toEqual({ active: 1, quiet: 1, dormant: 1, never: 1, logins7: 2 });
  });
});
