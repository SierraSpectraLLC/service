import { describe, expect, it } from "vitest";
import { mailHost, threadHeaders, threadRootId } from "@/lib/emailThread";

// A recurring email lands in one conversation only if the id it claims to
// answer never moves. Every case here is a way that id could drift - and a
// drifting root is a new thread every morning, which is the bug this exists
// to prevent.

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

  it("is a well-formed message id, stable for a key", () => {
    const id = threadRootId("org-5", "sierraspectra.com");
    expect(id).toBe("<digest.org-5@sierraspectra.com>");
    expect(threadRootId("org-5", "sierraspectra.com")).toBe(id);
  });

  it("keeps engagements apart - one client's chain is never another's", () => {
    const host = "sierraspectra.com";
    const ids = ["org-5", "org-9", "internal-2"].map((k) => threadRootId(k, host));
    expect(new Set(ids).size).toBe(3);
  });

  it("strips anything that would break the id's syntax", () => {
    expect(threadRootId("org 5 <bad>", "x.com")).toBe("<digest.org-5--bad-@x.com>");
  });

  it("sets both headers - clients read one or the other, not always the same one", () => {
    const id = threadRootId("org-5", "sierraspectra.com");
    expect(threadHeaders(id)).toEqual({ "In-Reply-To": id, References: id });
  });
});
