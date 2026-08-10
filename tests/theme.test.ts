import { describe, expect, it } from "vitest";
import { isValidHex, luminance, readableTextOn, tint } from "@/lib/theme";
import { canSeeCosts, redactParts } from "@/lib/redact";

describe("workspace theme helpers", () => {
  it("accepts only #rrggbb", () => {
    expect(isValidHex("#2E6B2E")).toBe(true);
    expect(isValidHex(" #2e6b2e ")).toBe(true);
    expect(isValidHex("#fff")).toBe(false);
    expect(isValidHex("2E6B2E")).toBe(false);
    expect(isValidHex("#2E6B2G")).toBe(false);
    expect(isValidHex("")).toBe(false);
  });

  it("keeps header text readable on any pick", () => {
    expect(readableTextOn("#172A4A")).toBe("#FFFFFF"); // house navy -> white
    expect(readableTextOn("#2E6B2E")).toBe("#FFFFFF"); // LabZen-ish green -> white
    expect(readableTextOn("#F4F6F9")).toBe("#172A4A"); // near-white -> navy
    expect(readableTextOn("#FFE599")).toBe("#172A4A"); // pale yellow -> navy
    expect(luminance("#000000")).toBe(0);
    expect(luminance("#FFFFFF")).toBeCloseTo(1);
  });

  it("tints toward white for the page background", () => {
    expect(tint("#2E6B2E", 1)).toBe("#FFFFFF");
    expect(tint("#2E6B2E", 0)).toBe("#2E6B2E");
    const washed = tint("#2E6B2E", 0.92);
    // Still green-leaning but nearly white.
    expect(luminance(washed)).toBeGreaterThan(0.8);
    expect(washed).not.toBe("#FFFFFF");
  });
});

describe("cost redaction", () => {
  const part = { cost: "1,240", po: "PO-8871", name: "Pump seal kit" };

  it("staff and the owning org see costs; everyone else does not", () => {
    expect(canSeeCosts({ role: "owner", orgId: null }, 5)).toBe(true);
    expect(canSeeCosts({ role: "staff", orgId: null }, null)).toBe(true);
    expect(canSeeCosts({ role: "client_editor", orgId: 5 }, 5)).toBe(true);
    expect(canSeeCosts({ role: "client_editor", orgId: 7 }, 5)).toBe(false); // provider on the system
    expect(canSeeCosts({ role: "client_viewer", orgId: 5 }, 5)).toBe(true);  // owning org, read-only
    expect(canSeeCosts({ role: "client_editor", orgId: 5 }, null)).toBe(false); // unowned system
  });

  it("blanks exactly the priced fields", () => {
    const provider = { role: "client_editor" as const, orgId: 7 };
    const owner = { role: "client_editor" as const, orgId: 5 };
    const [r] = redactParts([part], provider, 5);
    expect(r.cost).toBe("");
    expect(r.po).toBe("");
    expect(r.name).toBe("Pump seal kit");
    expect(redactParts([part], owner, 5)[0].cost).toBe("1,240");
  });

  it("costs follow whoever paid, not whoever owns the system now", () => {
    // LabZen (5) bought this part, then handed the system to Acme (9).
    const bought = { ...part, ownerOrgId: 5 };
    const acme = { role: "client_editor" as const, orgId: 9 };
    const labzen = { role: "client_editor" as const, orgId: 5 };
    // Acme owns the system now and still must not see what LabZen paid.
    expect(redactParts([bought], acme, 9)[0].cost).toBe("");
    expect(redactParts([bought], labzen, 9)[0].cost).toBe("1,240");
    // Acme's own later purchase on the same system is theirs to see.
    const mine = { ...part, ownerOrgId: 9 };
    expect(redactParts([mine], acme, 9)[0].cost).toBe("1,240");
    expect(redactParts([mine], labzen, 9)[0].cost).toBe("");
  });

  it("an unstamped row falls back to the system's owner", () => {
    // Pre-handoff rows: nothing had changed hands, so today's owner is right.
    const legacy = { ...part, ownerOrgId: null };
    expect(redactParts([legacy], { role: "client_editor", orgId: 5 }, 5)[0].cost).toBe("1,240");
    expect(redactParts([legacy], { role: "client_editor", orgId: 7 }, 5)[0].cost).toBe("");
    // Staff always see costs, stamped or not.
    expect(redactParts([legacy], { role: "staff", orgId: null }, 5)[0].cost).toBe("1,240");
  });
});
