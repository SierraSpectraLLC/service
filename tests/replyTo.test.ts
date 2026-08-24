import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { replyToAddress } from "@/lib/email";

/**
 * The sending domain is a send-only subdomain: it carries its own reputation
 * and the only MX on it is Resend's bounce collector. Nothing delivers a
 * human's reply there.
 *
 * That is fine for a From and fatal for a To. Both the digest and the EOD
 * report go to a whole client team on one message - which is deliberate, so
 * that reply-all reaches everybody - and the moment somebody uses it, the
 * answer lands on an address with nowhere to go. Naming a real inbox here is
 * what keeps a report a conversation instead of a broadcast.
 */
const saved = { REPLY_TO: process.env.REPLY_TO, DIGEST_REPLY_TO: process.env.DIGEST_REPLY_TO };
beforeEach(() => { delete process.env.REPLY_TO; delete process.env.DIGEST_REPLY_TO; });
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe("where a reply to a broadcast lands", () => {
  it("is undefined when nothing is set, so Resend omits the header", () => {
    // Not the empty string: an empty reply_to is a header pointing at nothing.
    expect(replyToAddress()).toBeUndefined();
  });

  it("uses REPLY_TO, the name that covers every broadcast this app sends", () => {
    process.env.REPLY_TO = "updates@ridgelinefield.com";
    expect(replyToAddress()).toBe("updates@ridgelinefield.com");
  });

  it("still honours DIGEST_REPLY_TO, which deployed instances are already set with", () => {
    process.env.DIGEST_REPLY_TO = "old@ridgelinefield.com";
    expect(replyToAddress()).toBe("old@ridgelinefield.com");
  });

  it("prefers the general name when both are set", () => {
    process.env.REPLY_TO = "new@ridgelinefield.com";
    process.env.DIGEST_REPLY_TO = "old@ridgelinefield.com";
    expect(replyToAddress()).toBe("new@ridgelinefield.com");
  });

  it("treats whitespace as unset rather than sending a blank header", () => {
    process.env.REPLY_TO = "   ";
    expect(replyToAddress()).toBeUndefined();
  });
});

describe("both daily reports are the same kind of mail", () => {
  /**
   * The regression this guards: sendEodEmail called sendEmail(to, subject,
   * html) with no options at all. Replies went to EMAIL_FROM on the send-only
   * subdomain and bounced for every recipient at once, and the report shared a
   * sending reputation with the sign-in links - so a client marking a report
   * as spam could cost somebody else the ability to get in.
   */
  it("the EOD report sends from the report address and takes replies elsewhere", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/app/actions.ts", "utf8");
    const at = src.indexOf("export async function sendEodEmail");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 2800);
    expect(body).toMatch(/sendEmail\(to, subject, html, \{[^}]*from: reportFrom\(\)/);
    expect(body).toMatch(/sendEmail\(to, subject, html, \{[^}]*replyTo: replyToAddress\(\)/);
  });

  it("the digest sends from the same address, so a client can filter them together", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync("src/lib/digest.ts", "utf8")).toContain("const from = reportFrom();");
  });
});

describe("who a daily report comes from", () => {
  const savedFrom = { DIGEST_EMAIL_FROM: process.env.DIGEST_EMAIL_FROM, EMAIL_FROM: process.env.EMAIL_FROM };
  afterEach(() => {
    for (const [k, v] of Object.entries(savedFrom)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it("prefers the reports' own sender", async () => {
    process.env.EMAIL_FROM = "login@mail.ridgelinefield.com";
    process.env.DIGEST_EMAIL_FROM = "updates@mail.ridgelinefield.com";
    const { reportFrom } = await import("@/lib/email");
    expect(reportFrom()).toBe("updates@mail.ridgelinefield.com");
  });

  it("falls back to EMAIL_FROM, which is how instances behaved before", async () => {
    process.env.EMAIL_FROM = "login@mail.ridgelinefield.com";
    delete process.env.DIGEST_EMAIL_FROM;
    const { reportFrom } = await import("@/lib/email");
    expect(reportFrom()).toBe("login@mail.ridgelinefield.com");
  });
});
