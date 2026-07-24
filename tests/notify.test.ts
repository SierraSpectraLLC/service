import { describe, it, expect } from "vitest";
import { resolveAssigneeEmail } from "@/lib/notify";

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
});
