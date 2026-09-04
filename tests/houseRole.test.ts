import { describe, expect, it } from "vitest";
import {
  houseIdentityFor, houseRoleFor, houseEmailsFrom, houseOwnerEmailsFrom, memberGuard, ownerEmails,
  rootOwner, validHouseEmail,
} from "@/lib/houseRole";

const ENV = ["joe@x.com", "legacy@x.com"];
const m = (email: string, role: string) => ({ email, role });

describe("rootOwner", () => {
  it("is the first env entry, or nothing", () => {
    expect(rootOwner(ENV)).toBe("joe@x.com");
    expect(rootOwner([])).toBeNull();
  });
});

describe("houseRoleFor", () => {
  it("makes the root env entry owner no matter what the table says", () => {
    // Lockout insurance: a bad Settings edit must never cost the way back in.
    expect(houseRoleFor("joe@x.com", ENV, [m("joe@x.com", "none")])).toBe("owner");
    expect(houseRoleFor("JOE@X.COM", ENV, [])).toBe("owner");
  });

  it("reads a table row for everyone else", () => {
    expect(houseRoleFor("bill@x.com", ENV, [m("bill@x.com", "owner")])).toBe("owner");
    expect(houseRoleFor("bill@x.com", ENV, [m("bill@x.com", "staff")])).toBe("staff");
    expect(houseRoleFor("bill@x.com", ENV, [])).toBeNull();
  });

  it("keeps legacy env staff working with no migration", () => {
    expect(houseRoleFor("legacy@x.com", ENV, [])).toBe("staff");
  });

  it("lets a 'none' row revoke somebody the env still lists", () => {
    expect(houseRoleFor("legacy@x.com", ENV, [m("legacy@x.com", "none")])).toBeNull();
  });

  it("is null for outsiders and blanks", () => {
    expect(houseRoleFor("nobody@x.com", ENV, [])).toBeNull();
    expect(houseRoleFor("", ENV, [])).toBeNull();
  });
});

describe("a managed row wins over the environment", () => {
  /*
   * The env list is lockout insurance for the company that runs the instance,
   * and it is a FALLBACK: it answers for an address that nothing else accounts
   * for. houseIdentityFor has always read it that way. The bug this pins is
   * what happened when the platform operator was split out of the service
   * company that used to be both - the service company's owner and engineer
   * were still in STAFF_EMAILS from when there was one house, so every surface
   * that read the env list without checking for a row filed them under the
   * platform. Their rows said otherwise the whole time.
   */
  const ENV = ["joe@sierra.com", "bill@sierra.com"];
  const SIERRA = 2, PLATFORM = 26;
  const members = [
    { email: "joe@sierra.com", role: "owner", orgId: SIERRA },
    { email: "bill@sierra.com", role: "staff", orgId: SIERRA },
    { email: "admin@platform.com", role: "owner", orgId: PLATFORM },
  ];

  it("keeps an env-listed address with the company its row names", () => {
    expect(houseIdentityFor("joe@sierra.com", ENV, members, PLATFORM))
      .toEqual({ role: "owner", orgId: SIERRA });
  });

  it("mails them as that company's staff, not the platform's", () => {
    expect(houseEmailsFrom(ENV, members, SIERRA, PLATFORM).sort())
      .toEqual(["bill@sierra.com", "joe@sierra.com"]);
    // The one that used to fail: the member loop skips rows belonging to
    // another workspace, so an address the env put in could never be taken
    // back out again.
    expect(houseEmailsFrom(ENV, members, PLATFORM, PLATFORM)).toEqual(["admin@platform.com"]);
  });

  it("still answers for an env address that has no row at all", () => {
    // Rowless is what the fallback is FOR - a break-glass address added to the
    // environment during a lockout, before anybody could add a row.
    const env = [...ENV, "rescue@platform.com"];
    expect(houseIdentityFor("rescue@platform.com", env, members, PLATFORM))
      .toEqual({ role: "staff", orgId: PLATFORM });
    expect(houseEmailsFrom(env, members, PLATFORM, PLATFORM).sort())
      .toEqual(["admin@platform.com", "rescue@platform.com"]);
  });

  it("reaches everybody on the instance for a platform-wide message", () => {
    expect(houseEmailsFrom(ENV, members).sort())
      .toEqual(["admin@platform.com", "bill@sierra.com", "joe@sierra.com"]);
  });
});

describe("houseEmailsFrom", () => {
  it("unions env and table, minus revocations", () => {
    const list = houseEmailsFrom(ENV, [m("bill@x.com", "staff"), m("legacy@x.com", "none")]);
    expect(list.sort()).toEqual(["bill@x.com", "joe@x.com"]);
  });
});

describe("ownerEmails", () => {
  it("counts the root plus table owners, and honours demotions", () => {
    expect(ownerEmails(ENV, [m("bill@x.com", "owner")]).sort()).toEqual(["bill@x.com", "joe@x.com"]);
    expect(ownerEmails(ENV, [m("bill@x.com", "staff")])).toEqual(["joe@x.com"]);
    // The root can't be demoted out of the owner set by a table row.
    expect(ownerEmails(ENV, [m("joe@x.com", "staff")])).toEqual(["joe@x.com"]);
  });

  it("can be a single table owner when no env is configured", () => {
    expect(ownerEmails([], [m("bill@x.com", "owner")])).toEqual(["bill@x.com"]);
  });
});

describe("validHouseEmail", () => {
  it("takes exact addresses only", () => {
    expect(validHouseEmail("bill@x.com")).toBe(true);
    expect(validHouseEmail(" Bill@X.com ")).toBe(true);
    for (const bad of ["@x.com", "bill", "bill@x", "a@b.com,c@d.com", "bill @x.com", ""]) {
      expect(validHouseEmail(bad)).toBe(false);
    }
  });
});

describe("memberGuard", () => {
  const base = { actorEmail: "joe@x.com", envStaff: ENV, members: [] as { email: string; role: string }[] };

  it("allows an ordinary grant", () => {
    expect(memberGuard({ ...base, subjectEmail: "bill@x.com", next: "staff" }).ok).toBe(true);
    expect(memberGuard({ ...base, subjectEmail: "bill@x.com", next: "owner" }).ok).toBe(true);
  });

  it("refuses to touch the root owner", () => {
    const res = memberGuard({ ...base, actorEmail: "bill@x.com", subjectEmail: "joe@x.com", next: "revoke" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("root owner");
  });

  it("refuses self-edits - there's no undo screen for that", () => {
    const res = memberGuard({
      ...base, actorEmail: "bill@x.com", subjectEmail: "BILL@x.com", next: "revoke",
      members: [m("bill@x.com", "owner")],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("your own access");
  });

  it("refuses to remove the last owner", () => {
    // No env at all, so the single table owner is the only one left.
    const res = memberGuard({
      actorEmail: "someone@x.com", subjectEmail: "bill@x.com", next: "revoke",
      envStaff: [], members: [m("bill@x.com", "owner")],
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("last owner");
  });

  it("allows demoting an owner while another remains", () => {
    expect(memberGuard({
      actorEmail: "joe@x.com", subjectEmail: "bill@x.com", next: "staff",
      envStaff: ENV, members: [m("bill@x.com", "owner")],
    }).ok).toBe(true);
  });

  it("rejects a domain wildcard", () => {
    expect(memberGuard({ ...base, subjectEmail: "@x.com", next: "staff" }).ok).toBe(false);
  });
});

describe("houseIdentityFor", () => {
  // "Staff" says nothing on its own once more than one service company shares the
  // instance. This is where the second half of the answer comes from.
  const ROOT = 1, LABZEN = 2;
  const row = (email: string, role: string, orgId: number | null) => ({ email, role, orgId });

  it("reads the company off the member's own row", () => {
    expect(houseIdentityFor("tech@labzen.com", ENV, [row("tech@labzen.com", "staff", LABZEN)], ROOT))
      .toEqual({ role: "staff", orgId: LABZEN });
  });

  it("puts the root owner at the operator that runs the instance", () => {
    // The break-glass login belongs to the company running the platform; giving
    // it any other answer would be a locked-out owner.
    expect(houseIdentityFor("joe@x.com", ENV, [], ROOT)).toEqual({ role: "owner", orgId: ROOT });
  });

  it("puts a legacy env-listed staffer there too", () => {
    expect(houseIdentityFor("legacy@x.com", ENV, [], ROOT)).toEqual({ role: "staff", orgId: ROOT });
  });

  it("keeps a row's company even when the environment also lists them", () => {
    expect(houseIdentityFor("legacy@x.com", ENV, [row("legacy@x.com", "staff", LABZEN)], ROOT))
      .toEqual({ role: "staff", orgId: LABZEN });
  });

  it("returns a company-less identity for a row that names none", () => {
    // Not the root's: a row that says nothing about its company must not be
    // silently adopted by the company running the platform. lib/tenants turns
    // this into "sees nothing" rather than "sees everything".
    expect(houseIdentityFor("tech@labzen.com", ENV, [row("tech@labzen.com", "staff", null)], ROOT))
      .toEqual({ role: "staff", orgId: null });
  });

  it("is nobody when the role is revoked", () => {
    expect(houseIdentityFor("tech@labzen.com", ENV, [row("tech@labzen.com", "none", LABZEN)], ROOT)).toBeNull();
  });

  it("is nobody for a client", () => {
    expect(houseIdentityFor("lab@acme.com", ENV, [], ROOT)).toBeNull();
  });
});

describe("houseOwnerEmailsFrom", () => {
  /*
   * Who accepted a hand-off, who took a lead: news that names a company the
   * owner chose to deal with, which the owner's engineers do not get to read.
   * The mail goes to the workspace's owners and to nobody else on it.
   */
  const ENV = ["joe@sierra.com", "bill@sierra.com"];
  const SIERRA = 2, PLATFORM = 26;
  const members = [
    { email: "joe@sierra.com", role: "owner", orgId: SIERRA },
    { email: "bill@sierra.com", role: "staff", orgId: SIERRA },
    { email: "ann@sierra.com", role: "owner", orgId: SIERRA },
    { email: "gone@sierra.com", role: "none", orgId: SIERRA },
    { email: "admin@platform.com", role: "owner", orgId: PLATFORM },
  ];

  it("names one workspace's owners and none of its staff", () => {
    expect(houseOwnerEmailsFrom(ENV, members, SIERRA, PLATFORM).sort())
      .toEqual(["ann@sierra.com", "joe@sierra.com"]);
  });

  it("does not cross workspaces, in either direction", () => {
    expect(houseOwnerEmailsFrom(ENV, members, PLATFORM, PLATFORM)).toEqual(["admin@platform.com"]);
    expect(houseOwnerEmailsFrom(ENV, members, 99, PLATFORM)).toEqual([]);
  });

  it("files the root owner where its row says, and at the root when it has none", () => {
    // Joe is STAFF_EMAILS[0] and has a Sierra row: Sierra's owner, not the platform's.
    expect(houseOwnerEmailsFrom(ENV, members, PLATFORM, PLATFORM)).not.toContain("joe@sierra.com");
    const rowless = members.filter((m) => m.email !== "joe@sierra.com");
    expect(houseOwnerEmailsFrom(ENV, rowless, PLATFORM, PLATFORM).sort())
      .toEqual(["admin@platform.com", "joe@sierra.com"]);
    expect(houseOwnerEmailsFrom(ENV, rowless, SIERRA, PLATFORM)).toEqual(["ann@sierra.com"]);
  });

  it("ignores a rowless legacy env entry and a revoked row", () => {
    // bill is in the env with no owner row: staff, so not here.
    expect(houseOwnerEmailsFrom(ENV, members, SIERRA, PLATFORM)).not.toContain("bill@sierra.com");
    expect(houseOwnerEmailsFrom(ENV, members, SIERRA, PLATFORM)).not.toContain("gone@sierra.com");
  });
});
