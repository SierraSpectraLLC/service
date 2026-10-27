import { describe, expect, it } from "vitest";
import {
  bytesOf, childPath, crumbs, downloadBlock, encodeCommand, formatSize, parentPath, parseCommand, parseListing,
  safeUploadName, uploadFrame,
} from "@/lib/remoteFiles";

// The files panel's protocol, without a socket. The failures worth catching
// here are quiet ones: a path that walks off to the wrong folder, a data block
// the agent reads as a command, a name that writes somewhere it shouldn't.

const bin = (bytes: number[]) => String.fromCharCode(...bytes);

describe("listings", () => {
  it("reads the agent's reply, folders first, by name the way a person sorts", () => {
    const l = parseListing({
      path: "C:/Data", reqid: 4, dir: [
        { n: "run10.csv", t: 3, s: 2048, d: "2026-10-20T10:00:00.000Z" },
        { n: "run9.csv", t: 3, s: 1024, d: "2026-10-19T10:00:00.000Z" },
        { n: "archive", t: 2, d: "2026-10-01T10:00:00.000Z" },
      ],
    })!;
    expect(l.reqid).toBe(4);
    expect(l.entries!.map((e) => e.name)).toEqual(["archive", "run9.csv", "run10.csv"]);
    expect(l.entries![1]).toMatchObject({ kind: "file", size: 1024 });
  });

  it("knows an unreadable folder from an empty one", () => {
    expect(parseListing({ path: "/root", reqid: 1, dir: null })!.entries).toBeNull();
    expect(parseListing({ path: "/tmp", reqid: 1, dir: [] })!.entries).toEqual([]);
  });

  it("ignores replies that are not listings", () => {
    expect(parseListing({ action: "uploadack", reqid: 1 })).toBeNull();
    expect(parseListing("nope")).toBeNull();
  });
});

describe("paths", () => {
  it("walks Windows from the drive list down and back", () => {
    expect(childPath("", "C:", "windows")).toBe("C:");
    expect(childPath("C:", "Users", "windows")).toBe("C:/Users");
    expect(childPath("C:\\Users\\", "bench", "windows")).toBe("C:/Users/bench");
    expect(parentPath("C:/Users/bench", "windows")).toBe("C:/Users");
    expect(parentPath("C:", "windows")).toBe("");
    expect(parentPath("", "windows")).toBeNull();
  });

  it("walks everything else from /", () => {
    expect(childPath("/", "home", "unix")).toBe("/home");
    expect(childPath("", "home", "unix")).toBe("/home");
    expect(childPath("/home", "bench", "unix")).toBe("/home/bench");
    expect(parentPath("/home/bench", "unix")).toBe("/home");
    expect(parentPath("/home", "unix")).toBe("/");
    expect(parentPath("/", "unix")).toBeNull();
  });

  it("breaks a path into steps that each lead somewhere", () => {
    expect(crumbs("C:/Users/bench", "windows")).toEqual([
      { label: "This PC", path: "" }, { label: "C:", path: "C:" },
      { label: "Users", path: "C:/Users" }, { label: "bench", path: "C:/Users/bench" },
    ]);
    expect(crumbs("/home/bench", "unix").map((c) => c.path)).toEqual(["/", "/home", "/home/bench"]);
  });
});

describe("the wire", () => {
  it("tells a command from file data by its first byte", () => {
    expect(parseCommand(bin([...encodeCommand({ action: "uploadstart", reqid: 2 })]))).toEqual({ action: "uploadstart", reqid: 2 });
    expect(parseCommand(bin([0, 0, 0, 1, 104, 105]))).toBeNull();
  });

  it("reads non-ASCII names from the agent's UTF-8", () => {
    const raw = bin([...new TextEncoder().encode(JSON.stringify({ path: "/", reqid: 1, dir: [{ n: "Résumé.pdf", t: 3, s: 5 }] }))]);
    expect(parseListing(parseCommand(raw))!.entries![0].name).toBe("Résumé.pdf");
  });

  it("finds the end of a download in the block's flags", () => {
    expect(downloadBlock(bin([0, 0, 0, 0, 1, 2, 3]))).toEqual({ data: new Uint8Array([1, 2, 3]), last: false });
    expect(downloadBlock(bin([0, 0, 0, 1]))).toEqual({ data: new Uint8Array([]), last: true });
  });

  it("escapes an upload block that would read as a command, and only that", () => {
    expect([...uploadFrame(new Uint8Array([123, 34]))]).toEqual([0, 123, 34]);
    expect([...uploadFrame(new Uint8Array([0, 9]))]).toEqual([0, 0, 9]);
    const plain = new Uint8Array([80, 75, 3, 4]);
    expect(uploadFrame(plain)).toBe(plain);
  });

  it("round-trips bytes through the transport's binary strings", () => {
    const all = Array.from({ length: 256 }, (_, i) => i);
    expect([...bytesOf(bin(all))]).toEqual(all);
  });
});

describe("names and sizes", () => {
  it("keeps an upload's name to its last part, so it can't climb out of the folder", () => {
    expect(safeUploadName("..\\..\\Windows\\system.ini")).toBe("system.ini");
    expect(safeUploadName("/etc/passwd")).toBe("passwd");
    expect(safeUploadName("re:port?.csv")).toBe("report.csv");
    expect(safeUploadName("..")).toBeNull();
    expect(safeUploadName("   ")).toBeNull();
  });

  it("says sizes the way a file manager does", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatSize(300 * 1024 * 1024)).toBe("300 MB");
  });
});
