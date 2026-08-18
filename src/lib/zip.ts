// A zip file, built by hand.
//
// The store needs "download these six as one file" twice - a selection on the
// Files page, and a share link's download-all - and pulling in an archiver
// dependency for that buys compression nobody asked for at the cost of a
// supply-chain edge on the one route that streams every byte a customer
// stores. PDFs and images are already compressed; a STORED (method 0) zip of
// them is within a percent of a DEFLATEd one and needs ~100 lines, all here.
//
// Format: PKZIP application note 4.5 - local file headers, central directory,
// end record. UTF-8 names (bit 11 set). No zip64, so a single archive tops out
// at 4GB/65k entries - far beyond what the size cap upstream allows through.

const te = new TextEncoder();

/** CRC-32, the polynomial every zip reader checks names against. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Zip-safe entry names: no paths, no duplicates.
 *
 * Two files called report.pdf are ordinary in a store; in one archive the
 * second silently shadows the first in most extractors, so it becomes
 * "report (2).pdf" - the rename every desktop has taught everybody.
 */
export function zipNames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((raw) => {
    // A path separator in a name would make extractors create directories -
    // or, with "..", write outside the target. Flattened, never trusted.
    const flat = (raw.split(/[/\\]/).pop() || "file").trim() || "file";
    const key = flat.toLowerCase();
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    if (n === 0) return flat;
    const dot = flat.lastIndexOf(".");
    return dot > 0 ? `${flat.slice(0, dot)} (${n + 1})${flat.slice(dot)}` : `${flat} (${n + 1})`;
  });
}

export type ZipEntry = { name: string; data: Uint8Array };

/** The finished archive, stored (uncompressed), names deduped and flattened. */
export function buildZip(entries: ZipEntry[]): Uint8Array {
  const names = zipNames(entries.map((e) => e.name));
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  const u16 = (n: number) => new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
  const u32 = (n: number) => new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]);
  const cat = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((t, p) => t + p.length, 0));
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  };

  entries.forEach((e, i) => {
    const name = te.encode(names[i]);
    const crc = crc32(e.data);
    // version 20, flags: bit 11 (UTF-8 names), method 0 (stored), dos time 0.
    const common = cat(u16(20), u16(0x0800), u16(0), u32(0), u32(crc), u32(e.data.length), u32(e.data.length), u16(name.length), u16(0));
    const local = cat(u32(0x04034b50), common, name);
    central.push(cat(u32(0x02014b50), u16(20), common, u16(0), u16(0), u16(0), u32(0), u32(offset), name));
    chunks.push(local, e.data);
    offset += local.length + e.data.length;
  });

  const dir = cat(...central);
  const end = cat(
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(dir.length), u32(offset), u16(0),
  );
  return cat(...chunks, dir, end);
}
