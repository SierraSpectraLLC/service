import { afterEach, describe, expect, it } from "vitest";
import { mailHost, threadHeaders, threadRootId } from "@/lib/emailThread";

// Each morning is its own conversation, and every copy of one morning is in
// it. The root id is what decides both: it moves with the DAY, so Tuesday and
// Monday never merge, and it does not move for anything else, so a cron send
// and a hand-pressed "send now" on the same day land together.
//
// Every case here is a way that id could drift when it should not, or hold
// still when it should move.

describe("the invented thread root", () => {
  it("takes its domain from the sending address, plain or with a name", () => {
    expect(mailHost("service@sierraspectra.com")).toBe("sierraspectra.com");
    expect(mailHost("Sierra Spectra <service@sierraspectra.com>")).toBe("sierraspectra.com");
  });

  it("is case-insensitive, so a retyped EMAIL_FROM doesn't split the thread", () => {
    expect(mailHost("Service@SierraSpectra.COM")).toBe("sierraspectra.com");
  });

  it("falls back rather than producing a malformed id", () => {
    expect(mailHost(undefined)).toBe("digest.invalid");
    expect(mailHost("not-an-address")).toBe("digest.invalid");
    expect(mailHost("", "house.example")).toBe("house.example");
  });

  it("is a well-formed message id, stable for a key and a day", () => {
    const id = threadRootId("org-5", "sierraspectra.com", "2026-08-26");
    expect(id).toBe("<digest.org-5.2026-08-26@sierraspectra.com>");
    // Twice on one day is the same conversation: a cron run and a resend are
    // two copies of one edition, not two editions.
    expect(threadRootId("org-5", "sierraspectra.com", "2026-08-26")).toBe(id);
  });

  it("GIVES EACH DATE ITS OWN CONVERSATION", () => {
    // The point of the whole file. Yesterday's digest and today's must not
    // collapse, or "the Tuesday digest" is a scroll position rather than a
    // message somebody can find, forward or reply to on its own.
    const host = "sierraspectra.com";
    const week = ["2026-08-24", "2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28"]
      .map((d) => threadRootId("internal-2", host, d));
    expect(new Set(week).size).toBe(5);
  });

  it("still keeps one running chain for a caller that asks for one", () => {
    // Omitting the day is the old behaviour, kept for anything that genuinely
    // wants a single thread. The digest is not one of those - see
    // sendDigestEdition, which passes the shop day.
    expect(threadRootId("org-5", "x.com")).toBe("<digest.org-5@x.com>");
    expect(threadRootId("org-5", "x.com")).toBe(threadRootId("org-5", "x.com"));
  });

  it("keeps engagements apart - one client's chain is never another's", () => {
    const host = "sierraspectra.com";
    const day = "2026-08-26";
    const ids = ["org-5", "org-9", "internal-2"].map((k) => threadRootId(k, host, day));
    expect(new Set(ids).size).toBe(3);
  });

  it("cannot let one engagement's day collide with another's", () => {
    // The day is joined with a separator that survives the id-safe pass, so
    // "org-5" on the 26th and a hypothetical key "org-5.2026-08" on the 26th
    // are still distinct strings rather than the same conversation.
    expect(threadRootId("org-5", "x.com", "2026-08-26"))
      .not.toBe(threadRootId("org-52026", "x.com", "08-26"));
  });

  it("strips anything that would break the id's syntax", () => {
    expect(threadRootId("org 5 <bad>", "x.com")).toBe("<digest.org-5--bad-@x.com>");
  });

  it("sets both headers - clients read one or the other, not always the same one", () => {
    const id = threadRootId("org-5", "sierraspectra.com", "2026-08-26");
    expect(threadHeaders(id)).toEqual({ "In-Reply-To": id, References: id });
  });
});

// The digest's own sending identity. Unset must behave exactly as before this
// existed, because that is every instance that has not set it.
describe("who the digest comes from", () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  it("falls back to the general sender when no digest address is set", async () => {
    const { digestFrom, digestReplyTo } = await import("@/lib/email");
    delete process.env.DIGEST_EMAIL_FROM;
    process.env.EMAIL_FROM = "Sierra Spectra <login@sierraspectra.com>";
    expect(digestFrom()).toBe("Sierra Spectra <login@sierraspectra.com>");
    expect(digestReplyTo()).toBeUndefined();
  });

  it("uses the digest address when one is set, and ignores an empty one", async () => {
    const { digestFrom } = await import("@/lib/email");
    process.env.EMAIL_FROM = "login@sierraspectra.com";
    process.env.DIGEST_EMAIL_FROM = "Sierra Spectra <dailydigest@service.sierraspectra.com>";
    expect(digestFrom()).toBe("Sierra Spectra <dailydigest@service.sierraspectra.com>");
    process.env.DIGEST_EMAIL_FROM = "   ";
    expect(digestFrom()).toBe("login@sierraspectra.com");
  });

  it("threads off the digest's own domain, subdomain included", async () => {
    expect(mailHost("Sierra Spectra <dailydigest@service.sierraspectra.com>"))
      .toBe("service.sierraspectra.com");
    expect(threadRootId("org-5", mailHost("dailydigest@service.sierraspectra.com"), "2026-08-26"))
      .toBe("<digest.org-5.2026-08-26@service.sierraspectra.com>");
  });
});
