import { describe, it, expect } from "vitest";
import { resolveAssigneeEmail, parseMentions } from "@/lib/notify";

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
