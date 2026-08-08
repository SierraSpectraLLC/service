import { describe, it, expect } from "vitest";
import { scopeFilter, isHouse, type ShareRow } from "@/lib/tenancy";

const share = (instrumentId: number, access = "view"): ShareRow => ({ instrumentId, access });

describe("isHouse", () => {
  it("is Sierra staff and owner only", () => {
    expect(isHouse("owner")).toBe(true);
    expect(isHouse("staff")).toBe(true);
    expect(isHouse("client_viewer")).toBe(false);
    expect(isHouse("client_editor")).toBe(false);
  });
});

describe("scopeFilter", () => {
  it("lets the house see everything, with no id list to maintain", () => {
    expect(scopeFilter("owner", null, [])).toEqual({ all: true });
    expect(scopeFilter("staff", null, [])).toEqual({ all: true });
  });

  it("shows an org exactly the systems shared with it", () => {
    const r = scopeFilter("client_editor", 7, [share(1, "edit"), share(4)]);
    expect(r.all).toBe(false);
    if (r.all) return;
    expect(r.ids.sort()).toEqual([1, 4]);
  });

  it("shows nothing when an org has no shares - never everything", () => {
    const r = scopeFilter("client_editor", 7, []);
    expect(r).toEqual({ all: false, ids: [], editable: new Set() });
  });

  it("shows nothing to a client with no organization assigned", () => {
    // An allowlist entry with no org must not become a key to the whole shop.
    const r = scopeFilter("client_editor", null, [share(1, "edit")]);
    expect(r).toEqual({ all: false, ids: [], editable: new Set() });
  });

  it("requires an edit share AND the editor role to edit", () => {
    const shares = [share(1, "edit"), share(2, "view")];
    const editor = scopeFilter("client_editor", 7, shares);
    const viewer = scopeFilter("client_viewer", 7, shares);
    if (editor.all || viewer.all) throw new Error("unreachable");
    // editor: only the edit-shared system
    expect([...editor.editable]).toEqual([1]);
    expect(editor.ids.sort()).toEqual([1, 2]);
    // viewer: sees both, edits neither
    expect([...viewer.editable]).toEqual([]);
    expect(viewer.ids.sort()).toEqual([1, 2]);
  });

  it("a view share stays read-only even for an editor org", () => {
    const r = scopeFilter("client_editor", 7, [share(9, "view")]);
    if (r.all) throw new Error("unreachable");
    expect(r.ids).toEqual([9]);
    expect(r.editable.has(9)).toBe(false);
  });

  it("dedupes ids if a system is shared twice", () => {
    const r = scopeFilter("client_viewer", 7, [share(3), share(3)]);
    if (r.all) throw new Error("unreachable");
    expect(r.ids).toEqual([3]);
  });
});
