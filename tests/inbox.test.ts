import { describe, expect, it } from "vitest";
import { NOTIFY_KINDS, emailAllowed, isNotifyKind } from "@/lib/inbox";

describe("emailAllowed", () => {
  it("defaults to on when nothing is stored", () => {
    expect(emailAllowed([], "discussion")).toBe(true);
  });

  it("honors an opt-out row for that kind only", () => {
    const prefs = [{ kind: "discussion", emailOn: false }];
    expect(emailAllowed(prefs, "discussion")).toBe(false);
    expect(emailAllowed(prefs, "task_assigned")).toBe(true);
  });

  it("honors an explicit opt-back-in row", () => {
    expect(emailAllowed([{ kind: "gas_empty", emailOn: true }], "gas_empty")).toBe(true);
  });
});

describe("NOTIFY_KINDS", () => {
  it("every kind is labeled and recognized", () => {
    for (const k of NOTIFY_KINDS) {
      expect(k.label.length).toBeGreaterThan(0);
      expect(isNotifyKind(k.kind)).toBe(true);
    }
    expect(isNotifyKind("password_reset")).toBe(false);
  });
});
