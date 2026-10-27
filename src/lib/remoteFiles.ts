/**
 * Moving files between the engineer's device and the far machine.
 *
 * The engine already carries files: a second relay session alongside the
 * desktop, protocol 5, which the agent answers with a small JSON command set
 * and chunked binary. Its console has a Files tab built on it; ours is
 * RemoteFiles.tsx, and everything here is the part that does not need a
 * socket - paths, what a reply means, how a chunk is framed - so it can be
 * tested on its own. Read off MeshCentral 1.2.4: default.handlebars (p13*,
 * the console's Files tab) and agents/meshcore.js (getDirectoryInfo, the
 * agent's side).
 *
 * The wire, briefly:
 *   ls        {action:"ls", reqid, path} -> {path, reqid, dir:[{n,t,s,d}] | null}
 *             t is 1 a drive, 2 a folder, 3 a file. An empty path is the top:
 *             the drives on Windows, "/" anywhere else. dir:null means the
 *             folder could not be read.
 *   download  {action:"download", sub:"start", id, path} -> {..., sub:"start"}
 *             -> we answer "startack" -> binary blocks, each a 4-byte flags
 *             word (bit 1 = last) and data; every non-last block is answered
 *             with sub:"ack". sub:"cancel" from either side ends it.
 *   upload    {action:"upload", reqid, path, name, size} -> "uploadstart";
 *             then raw blocks, each answered "uploadack", then our
 *             "uploaddone" -> theirs. "uploaderror" ends it. A block whose
 *             first byte is "{" or 0 is sent with a 0 in front, so the agent
 *             can never mistake data for a command.
 */

export type RemoteEntry = {
  name: string;
  kind: "drive" | "folder" | "file";
  /** Bytes; a drive's capacity, a file's length, 0 for a folder. */
  size: number;
  /** ISO time it was last changed, or "" when the agent did not say. */
  modified: string;
};

export type Listing = { path: string; reqid: number; entries: RemoteEntry[] | null };

const KINDS: Record<number, RemoteEntry["kind"]> = { 1: "drive", 2: "folder", 3: "file" };

/** Folders first (drives, then folders), then files, each by name the way a person sorts. */
export function sortEntries(entries: RemoteEntry[]): RemoteEntry[] {
  const rank = { drive: 0, folder: 1, file: 2 } as const;
  return [...entries].sort((a, b) =>
    rank[a.kind] - rank[b.kind] || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

/** A listing reply, or null for anything that is not one. */
export function parseListing(msg: unknown): Listing | null {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as { path?: unknown; reqid?: unknown; dir?: unknown; action?: unknown };
  if (m.action !== undefined || typeof m.path !== "string") return null;
  const reqid = Number(m.reqid);
  if (m.dir === null) return { path: m.path, reqid, entries: null };
  if (!Array.isArray(m.dir)) return null;
  const entries: RemoteEntry[] = [];
  for (const raw of m.dir) {
    const e = raw as { n?: unknown; t?: unknown; s?: unknown; d?: unknown };
    const kind = KINDS[Number(e.t)];
    if (!kind || typeof e.n !== "string" || !e.n) continue;
    entries.push({
      name: e.n, kind,
      size: typeof e.s === "number" && e.s > 0 ? e.s : 0,
      modified: typeof e.d === "string" ? e.d : "",
    });
  }
  return { path: m.path, reqid, entries: sortEntries(entries) };
}

// ---------------- Paths ----------------
//
// One string, the way the agent takes it: "" for the top, "C:/Users/bench"
// on Windows (forward slashes - the agent joins with its own), "/home/bench"
// anywhere else. Which kind of machine it is shows in the first listing: only
// Windows answers the top with drives.

export type Flavor = "windows" | "unix";

const trimEnd = (p: string) => p.replace(/[\\/]+$/, "");

/** The path of something inside `folder`. */
export function childPath(folder: string, name: string, flavor: Flavor): string {
  const base = trimEnd(folder.replace(/\\/g, "/"));
  if (flavor === "unix") return `${base}/${name}`.replace(/^\/*/, "/");
  return base ? `${base}/${name}` : name;
}

/** One level up, or null at the top. */
export function parentPath(path: string, flavor: Flavor): string | null {
  const p = trimEnd(path.replace(/\\/g, "/"));
  if (flavor === "unix") {
    if (p === "") return null;
    const cut = p.lastIndexOf("/");
    return cut <= 0 ? "/" : p.slice(0, cut);
  }
  if (p === "") return null;
  const cut = p.lastIndexOf("/");
  return cut < 0 ? "" : p.slice(0, cut);
}

/**
 * The path as clickable steps, top first: each with what to show and where it
 * goes. The top is called "This PC" on Windows, where it is the drive list,
 * and "/" elsewhere.
 */
export function crumbs(path: string, flavor: Flavor): { label: string; path: string }[] {
  const p = trimEnd(path.replace(/\\/g, "/"));
  const top = flavor === "windows" ? { label: "This PC", path: "" } : { label: "/", path: "/" };
  const parts = p.split("/").filter(Boolean);
  const out = [top];
  let at = "";
  for (const part of parts) {
    at = flavor === "windows" ? (at ? `${at}/${part}` : part) : `${at}/${part}`;
    out.push({ label: part, path: at });
  }
  return out;
}

// ---------------- Bytes ----------------

/** What the agent sends as text is UTF-8, delivered one byte per char. */
export function bytesOf(binary: string): Uint8Array {
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i) & 0xff;
  return out;
}

/** A JSON command from the agent, or null when the bytes are file data. */
export function parseCommand(binary: string): Record<string, unknown> | null {
  if (binary.length === 0 || binary.charCodeAt(0) !== 123) return null;
  try { return JSON.parse(new TextDecoder().decode(bytesOf(binary))); } catch { return null; }
}

/** A command for the agent, as the UTF-8 bytes the transport sends. */
export function encodeCommand(cmd: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(cmd));
}

/** One downloaded block: its data, and whether it is the last. */
export function downloadBlock(binary: string): { data: Uint8Array; last: boolean } {
  const head = bytesOf(binary.slice(0, 4));
  const flags = ((head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3]) >>> 0;
  return { data: bytesOf(binary.slice(4)), last: (flags & 1) !== 0 };
}

/** How much of a file goes in one upload block - the engine's own size over a relay. */
export const UPLOAD_BLOCK = 65536;
/** Blocks sent ahead of the first acknowledgement, to fill the pipe - the engine's figure. */
export const UPLOAD_PRIMING = 8;

/** An upload block as sent: escaped with a leading 0 when it could read as a command. */
export function uploadFrame(block: Uint8Array): Uint8Array {
  if (block.length === 0 || (block[0] !== 123 && block[0] !== 0)) return block;
  const out = new Uint8Array(block.length + 1);
  out.set(block, 1);
  return out;
}

/** 1536 -> "1.5 KB". Plain, base-1024, the way a file manager says it. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

/**
 * A name that is safe to write on the far machine: a file the user picked,
 * reduced to its last component, with nothing a path could hide in. The agent
 * joins it onto the folder as given, so "..\\..\\Windows\\x" must never reach it.
 */
export function safeUploadName(raw: string): string | null {
  const last = raw.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = last.replace(/[\u0000-\u001f<>:"|?*]/g, "").trim();
  if (!clean || clean === "." || clean === "..") return null;
  return clean.slice(0, 255);
}
