import { describe, expect, it } from "vitest";
import {
  canMoveFolder, childrenOf, cleanFolderName, depthOf, descendantIds, folderContents,
  folderPath, MAX_DEPTH, nameTaken,
} from "@/lib/folders";

//  Manuals ─┬─ Shimadzu ── LC
//           └─ Thermo
//  Certs
const TREE = [
  { id: 1, name: "Manuals", parentId: null },
  { id: 2, name: "Shimadzu", parentId: 1 },
  { id: 3, name: "Thermo", parentId: 1 },
  { id: 4, name: "LC", parentId: 2 },
  { id: 5, name: "Certs", parentId: null },
];

describe("naming a folder", () => {
  it("takes an ordinary name, tidied", () => {
    expect(cleanFolderName("  Service   reports ")).toEqual({ name: "Service reports" });
  });

  it("refuses a slash rather than swallowing it", () => {
    // "a/b" reads as two folders to every human who sees it; keeping it as one
    // is a lie the first time somebody goes looking for "b".
    expect("error" in cleanFolderName("Manuals/Shimadzu")).toBe(true);
    expect("error" in cleanFolderName("a\\b")).toBe(true);
  });

  it("refuses nothing, a novel, and the two names that mean something else", () => {
    expect("error" in cleanFolderName("   ")).toBe(true);
    expect("error" in cleanFolderName("x".repeat(200))).toBe(true);
    expect("error" in cleanFolderName("..")).toBe(true);
  });
});

describe("reading the tree", () => {
  it("lists what is directly inside, by name", () => {
    expect(childrenOf(TREE, null).map((f) => f.name)).toEqual(["Certs", "Manuals"]);
    expect(childrenOf(TREE, 1).map((f) => f.name)).toEqual(["Shimadzu", "Thermo"]);
    expect(childrenOf(TREE, 4)).toEqual([]);
  });

  it("walks the breadcrumb from the root down", () => {
    expect(folderPath(TREE, 4).map((f) => f.name)).toEqual(["Manuals", "Shimadzu", "LC"]);
    expect(folderPath(TREE, null)).toEqual([]);
    expect(depthOf(TREE, 4)).toBe(3);
    expect(depthOf(TREE, null)).toBe(0);
  });

  it("survives a cycle rather than hanging on one", () => {
    // Nothing may create one; a breadcrumb is not where you find out one exists.
    const bad = [{ id: 1, name: "a", parentId: 2 }, { id: 2, name: "b", parentId: 1 }];
    expect(folderPath(bad, 1).length).toBeLessThanOrEqual(MAX_DEPTH + 1);
  });

  it("finds everything inside, at any depth", () => {
    expect(descendantIds(TREE, 1).sort()).toEqual([2, 3, 4]);
    expect(descendantIds(TREE, 4)).toEqual([]);
  });
});

describe("moving a folder", () => {
  it("allows an ordinary move, including out to the root", () => {
    expect(canMoveFolder(TREE, 4, 5)).toEqual({ ok: true });
    expect(canMoveFolder(TREE, 2, null)).toEqual({ ok: true });
  });

  it("refuses a folder into itself or its own child, distinctly", () => {
    // Either would detach the branch: the rows survive and nothing lists them.
    expect(canMoveFolder(TREE, 1, 1)).toEqual({ ok: false, error: "A folder can't go inside itself" });
    expect(canMoveFolder(TREE, 1, 4)).toEqual({ ok: false, error: "That folder is inside this one" });
  });

  it("refuses a destination that is gone", () => {
    expect("error" in canMoveFolder(TREE, 4, 99) && !canMoveFolder(TREE, 4, 99).ok).toBe(true);
  });

  it("refuses a move that would bury the branch too deep", () => {
    const deep = Array.from({ length: MAX_DEPTH }, (_, i) => ({
      id: i + 1, name: `d${i}`, parentId: i === 0 ? null : i,
    }));
    // Carrying a two-tall branch into the deepest folder overflows.
    const withBranch = [...deep, { id: 90, name: "top", parentId: null }, { id: 91, name: "kid", parentId: 90 }];
    expect(canMoveFolder(withBranch, 90, MAX_DEPTH).ok).toBe(false);
  });
});

describe("names beside each other", () => {
  it("catches a duplicate among siblings only, ignoring case", () => {
    expect(nameTaken(TREE, 1, "shimadzu")).toBe(true);
    expect(nameTaken(TREE, null, "Shimadzu")).toBe(false);
    // Renaming a folder to what it already is, is not a clash.
    expect(nameTaken(TREE, 1, "Shimadzu", 2)).toBe(false);
  });
});

describe("what is in there before it is deleted", () => {
  const files = [{ folderId: 4 }, { folderId: 4 }, { folderId: 5 }, { folderId: null }];

  it("counts everything at any depth, so the confirmation is honest", () => {
    expect(folderContents(TREE, 1, files)).toEqual({ folders: 3, files: 2 });
    expect(folderContents(TREE, 5, files)).toEqual({ folders: 0, files: 1 });
  });

  it("reports empty as empty", () => {
    expect(folderContents(TREE, 3, files)).toEqual({ folders: 0, files: 0 });
  });
});
