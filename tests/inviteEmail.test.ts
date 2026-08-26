// What an invitation actually says when it carries a password.
//
// The action hands notifyInvite a plaintext password; this is the other half -
// that it reaches the body, with its expiry beside it, and that the copy
// matches what was done. Three shapes share one email and they must not be
// allowed to drift into each other: no password at all (sign in by code), a
// password that exists but is being read down a phone, and a password printed
// right here.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mails: Array<{ to: string[]; subject: string; body: string }> = [];

vi.mock("@/lib/email", () => ({
  sendEmail: async (to: string[], subject: string, body: string) => {
    mails.push({ to, subject, body });
  },
}));
vi.mock("@/lib/brand", () => ({ getBrand: async () => ({ name: "Ridgeline" }) }));
vi.mock("@/lib/appUrl", () => ({ appUrl: () => "https://ridgelinefield.com" }));
vi.mock("@/db", () => ({ db: {} }));

const { notifyInvite } = await import("@/lib/notify");

const BASE = { to: "thomas@labzen.test", inviterName: "Dev", orgName: "Lab Zen" };
const body = () => mails[0]?.body ?? "";

beforeEach(() => { mails.length = 0; });

describe("an invitation carrying a password", () => {
  it("PRINTS THE PASSWORD IN THE BODY", async () => {
    await notifyInvite({ ...BASE, tempPasswordPlain: "harbor-quartz-elm-4193", tempExpiresOn: "2026-09-09" });
    expect(body()).toContain("harbor-quartz-elm-4193");
  });

  it("prints the day it stops working beside it", async () => {
    // A password with no visible end reads as a permanent one.
    await notifyInvite({ ...BASE, tempPasswordPlain: "harbor-quartz-elm-4193", tempExpiresOn: "2026-09-09" });
    expect(body()).toContain("2026-09-09");
    expect(body()).toMatch(/Works until/);
  });

  it("tells them to use it, rather than to wait for a phone call", async () => {
    await notifyInvite({ ...BASE, tempPasswordPlain: "harbor-quartz-elm-4193", tempExpiresOn: "2026-09-09" });
    expect(body()).toMatch(/temporary password below/);
    expect(body()).not.toMatch(/whoever added you will pass it on/);
  });

  it("still points at the sign-in page", async () => {
    await notifyInvite({ ...BASE, tempPasswordPlain: "harbor-quartz-elm-4193", tempExpiresOn: "2026-09-09" });
    expect(body()).toContain("https://ridgelinefield.com/login");
  });
});

describe("the two shapes that carry no password", () => {
  it("says a code is emailed when there is no password at all", async () => {
    await notifyInvite(BASE);
    expect(body()).toMatch(/a sign-in code is emailed to you/);
    expect(body()).not.toMatch(/Your temporary password/);
  });

  it("KEEPS THE SPOKEN-PASSWORD WORDING for the boolean form", async () => {
    /* addClientPerson still uses this: a password was set, and it is being
       read out rather than mailed. Nothing here may leak the value, because
       the caller never handed one over in the first place. */
    await notifyInvite({ ...BASE, tempPassword: true });
    expect(body()).toMatch(/whoever added you will pass it on/);
    expect(body()).not.toMatch(/Your temporary password/);
  });

  it("does not print an empty password box when the plaintext is blank", async () => {
    // An empty string is not "a password to show" - it is a caller bug, and a
    // box with nothing in it would send somebody hunting for a value.
    await notifyInvite({ ...BASE, tempPasswordPlain: "" });
    expect(body()).not.toMatch(/Your temporary password/);
  });
});

describe("what it does not do", () => {
  it("escapes the password rather than trusting it into the markup", async () => {
    await notifyInvite({ ...BASE, tempPasswordPlain: "<script>x</script>", tempExpiresOn: "2026-09-09" });
    expect(body()).not.toContain("<script>x</script>");
    expect(body()).toContain("&lt;script&gt;");
  });

  it("keeps the password out of the subject and the preheader", async () => {
    // Both are shown in an inbox list, over somebody's shoulder, unopened.
    await notifyInvite({ ...BASE, tempPasswordPlain: "harbor-quartz-elm-4193", tempExpiresOn: "2026-09-09" });
    expect(mails[0].subject).not.toContain("harbor-quartz-elm-4193");
    const pre = body().slice(0, body().indexOf("Dev added you"));
    expect(pre).not.toContain("harbor-quartz-elm-4193");
  });
});
