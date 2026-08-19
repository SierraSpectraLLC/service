import { describe, it, expect } from "vitest";
import { resolveAssigneeEmail, parseMentions, usageReportBody } from "@/lib/notify";
import type { PersonUsage } from "@/lib/loginLog";

const STAFF = ["joe.vincent96@gmail.com", "bill@sierraspectra.com"];

describe("resolveAssigneeEmail", () => {
  it("prefers an exact users.name match", () => {
    const rows = [{ name: "Joe", email: "Joe.Vincent96@gmail.com" }];
    expect(resolveAssigneeEmail("Joe", STAFF, rows)).toBe("joe.vincent96@gmail.com");
  });
  it("falls back to a staff email whose local part starts with the name", () => {
    expect(resolveAssigneeEmail("bill", STAFF, [])).toBe("bill@sierraspectra.com");
    expect(resolveAssigneeEmail("Joe", STAFF, [])).toBe("joe.vincent96@gmail.com");
  });
  it("returns null for unknown or blank assignees", () => {
    expect(resolveAssigneeEmail("Pradeep", STAFF, [])).toBeNull();
    expect(resolveAssigneeEmail("", STAFF, [])).toBeNull();
  });
  it("prefers the people roster over everything else", () => {
    const roster = [{ name: "Thomas", email: "Thomas@LabZenLLC.com" }];
    expect(resolveAssigneeEmail("thomas", STAFF, [], roster)).toBe("thomas@labzenllc.com");
  });
  it("skips roster entries with a blank email", () => {
    const roster = [{ name: "Joe", email: "" }];
    expect(resolveAssigneeEmail("Joe", STAFF, [], roster)).toBe("joe.vincent96@gmail.com");
  });
});

describe("parseMentions", () => {
  const NAMES = ["Joe", "Thomas", "Chris Ma"];
  it("matches full names and first names, case-insensitive", () => {
    expect(parseMentions("@Thomas can you 3D print this?", NAMES)).toEqual(["Thomas"]);
    expect(parseMentions("cc @chris ma and @JOE", NAMES)).toEqual(["Joe", "Chris Ma"]);
    expect(parseMentions("@Chris please review", NAMES)).toEqual(["Chris Ma"]);
  });
  it("ignores plain names without the @ and unknown mentions", () => {
    expect(parseMentions("Thomas is on it", NAMES)).toEqual([]);
    expect(parseMentions("@Pradeep hello", NAMES)).toEqual([]);
  });
});

describe("usageReportBody", () => {
  const now = new Date("2026-08-19T12:00:00Z");
  const ago = (days: number) => new Date(now.getTime() - days * 86400000);
  const person = (name: string, over: Partial<PersonUsage> = {}): PersonUsage => ({
    email: `${name}@x.com`, name, role: "staff", orgName: "",
    lastSeenAt: ago(1), lastLoginAt: ago(1), logins7: 1, logins30: 1,
    methods: ["code"], hasPassword: false, invitedNeverIn: false, status: "active", ...over,
  });

  it("counts people, not sign-ins, in the headline", () => {
    const { title } = usageReportBody({ active: [person("a"), person("b")], dormant: [], logins: 9, now });
    expect(title).toBe("2 people used the portal this week");
    expect(usageReportBody({ active: [person("a")], dormant: [], logins: 1, now }).title)
      .toBe("1 person used the portal this week");
  });

  it("says so plainly when nobody came, rather than showing an empty table", () => {
    const { title, body } = usageReportBody({ active: [], dormant: [person("z", { status: "dormant" })], logins: 0, now });
    expect(title).toBe("0 people used the portal this week");
    expect(body).toContain("Nobody opened the portal this week");
    expect(body).toContain("Not seen in a month");
  });

  it("leaves out the dormant section when there is nobody in it", () => {
    const { body } = usageReportBody({ active: [person("a")], dormant: [], logins: 1, now });
    expect(body).not.toContain("Not seen in a month");
  });

  it("escapes names rather than pasting them into the markup", () => {
    const { body } = usageReportBody({
      active: [person("a", { name: "Q<script>", orgName: "A & B" })], dormant: [], logins: 1, now,
    });
    expect(body).not.toContain("<script>");
    expect(body).toContain("A &amp; B");
  });
});
