import { describe, expect, it } from "vitest";
import {
  browseListing, itemNote, pushCrumb, ROOT, searchListing, toCloudItem, truncateTo, type CloudItem,
} from "@/lib/cloudItems";

const file = (name: string, size = 1024, id = name) =>
  ({ id, name, size, lastModifiedDateTime: "2026-08-01T10:00:00Z", file: { mimeType: "application/pdf" },
    parentReference: { driveId: "d1" } });
const folder = (name: string, childCount = 3, id = name) =>
  ({ id, name, folder: { childCount }, parentReference: { driveId: "d1" } });

describe("translating what Microsoft sends back", () => {
  it("reads a file", () => {
    expect(toCloudItem(file("tune.pdf", 2048))).toEqual({
      id: "tune.pdf", name: "tune.pdf", isFolder: false, size: 2048,
      modified: "2026-08-01T10:00:00Z", childCount: 0, driveId: "d1",
    });
  });

  it("reads a folder by the presence of the folder object, not a type field", () => {
    const f = toCloudItem(folder("Reports", 12));
    expect(f?.isFolder).toBe(true);
    expect(f?.childCount).toBe(12);
    expect(f?.size).toBe(0);
  });

  it("follows a shared folder to the drive it actually lives on", () => {
    // The case that breaks a browser the moment somebody clicks a shared library:
    // the id that addresses the contents is inside remoteItem, on another drive.
    const shared = {
      id: "pointer-in-my-drive", name: "LabZen Reports",
      parentReference: { driveId: "mine" },
      remoteItem: { id: "real-id", folder: { childCount: 4 }, parentReference: { driveId: "theirs" } },
    };
    expect(toCloudItem(shared)).toMatchObject({ id: "real-id", driveId: "theirs", isFolder: true, childCount: 4 });
  });

  it("falls back to the drive the caller was browsing when the item omits one", () => {
    expect(toCloudItem({ id: "x", name: "a.pdf" }, "browsing")?.driveId).toBe("browsing");
  });

  it("drops an item with no id rather than making one up", () => {
    expect(toCloudItem({ name: "orphan.pdf" })).toBeNull();
  });

  it("has a name for an item that arrived without one", () => {
    expect(toCloudItem({ id: "x" })?.name).toBe("(unnamed)");
  });
});

describe("a folder's contents, ready to show", () => {
  const raw = [
    file("zeta.pdf"), folder("Archive"), file("alpha.pdf"), file("budget.xlsx"),
    folder("2026 Reports"), file("photo.jpg"), file("Tune 10.pdf"), file("Tune 2.pdf"),
  ];

  it("puts folders first, then PDFs, each A-Z", () => {
    expect(browseListing(raw).map((i) => i.name))
      .toEqual(["2026 Reports", "Archive", "alpha.pdf", "Tune 2.pdf", "Tune 10.pdf", "zeta.pdf"]);
  });

  it("leaves out what the studio could not open anyway", () => {
    // Not greyed out - gone. This browser exists to find a PDF, and a list padded
    // with spreadsheets is the file dialog somebody came here to avoid.
    expect(browseListing(raw).some((i) => /xlsx|jpg/.test(i.name))).toBe(false);
  });

  it("sorts numbered files the way a person reads them", () => {
    const names = browseListing([file("Tune 10.pdf"), file("Tune 2.pdf")]).map((i) => i.name);
    expect(names).toEqual(["Tune 2.pdf", "Tune 10.pdf"]);
  });

  it("returns no folders from a search - you searched for a file", () => {
    expect(searchListing(raw).map((i) => i.name))
      .toEqual(["alpha.pdf", "Tune 2.pdf", "Tune 10.pdf", "zeta.pdf"]);
  });

  it("copes with an empty folder", () => {
    expect(browseListing([])).toEqual([]);
  });
});

describe("the trail back", () => {
  const f = (name: string, id: string, driveId = "d1"): CloudItem =>
    ({ id, name, isFolder: true, size: 0, modified: "", childCount: 0, driveId });

  it("grows as you descend", () => {
    const t = pushCrumb(pushCrumb([ROOT], f("Reports", "r1")), f("2026", "r2"));
    expect(t.map((c) => c.name)).toEqual(["Files", "Reports", "2026"]);
    expect(t[2].driveId).toBe("d1");
  });

  it("cuts back to whichever crumb was clicked", () => {
    const t = pushCrumb(pushCrumb([ROOT], f("Reports", "r1")), f("2026", "r2"));
    expect(truncateTo(t, "r1").map((c) => c.name)).toEqual(["Files", "Reports"]);
    expect(truncateTo(t, "root").map((c) => c.name)).toEqual(["Files"]);
  });

  it("leaves the trail alone for a crumb that is not in it", () => {
    const t = [ROOT];
    expect(truncateTo(t, "nowhere")).toBe(t);
  });
});

describe("the line under a name", () => {
  it("counts a folder's contents", () => {
    expect(itemNote({ ...ROOT, name: "R", isFolder: true, size: 0, modified: "", childCount: 1 } as CloudItem))
      .toBe("1 item");
    expect(itemNote({ ...ROOT, name: "R", isFolder: true, size: 0, modified: "", childCount: 9 } as CloudItem))
      .toBe("9 items");
  });

  it("sizes a file, and never rounds a small one to zero", () => {
    const at = (size: number) =>
      itemNote({ id: "x", name: "a.pdf", isFolder: false, size, modified: "", childCount: 0, driveId: "" });
    expect(at(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(at(300 * 1024)).toBe("300 KB");
    expect(at(12)).toBe("1 KB");
  });
});
