import { describe, expect, it } from "vitest";
import { parsePersona } from "@/lib/viewAs";

// The cookie only names a persona - identity comes from the session - but a
// malformed or hostile value must never resolve to a usable one, and the
// permission level must be exactly what was asked for.
describe("view-as cookie", () => {
  it("reads an org id and permission level", () => {
    expect(parsePersona("5:editor")).toEqual({ orgId: 5, role: "client_editor" });
    expect(parsePersona("5:viewer")).toEqual({ orgId: 5, role: "client_viewer" });
  });

  it("defaults to editor when the level is absent or unknown", () => {
    expect(parsePersona("7")).toEqual({ orgId: 7, role: "client_editor" });
    expect(parsePersona("7:banana")).toEqual({ orgId: 7, role: "client_editor" });
  });

  it("refuses anything that isn't a real org id", () => {
    expect(parsePersona(undefined)).toBeNull();
    expect(parsePersona("")).toBeNull();
    expect(parsePersona("abc:editor")).toBeNull();
    expect(parsePersona("0:editor")).toBeNull();
    expect(parsePersona(":editor")).toBeNull();
  });

  it("never yields a house role, whatever the cookie says", () => {
    for (const raw of ["5:owner", "5:staff", "5:editor", "5:viewer"]) {
      const p = parsePersona(raw);
      expect(p).not.toBeNull();
      expect(["client_editor", "client_viewer"]).toContain(p!.role);
    }
  });
});
