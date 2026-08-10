import { describe, expect, it } from "vitest";
import {
  houseRoleFor, houseEmailsFrom, memberGuard, ownerEmails, rootOwner, validHouseEmail,
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
