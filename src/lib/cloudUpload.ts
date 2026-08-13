// Arithmetic and string cleaning for sending a packet to an outside file store.
//
// Its own module, and deliberately importing nothing, because BOTH ends need it:
// the server mints the upload session, and the browser does the actual PUTs -
// the bytes go straight from the tab to Microsoft rather than through a
// serverless function whose request body is capped well below the size of a
// scanned packet.
//
// That split is why this is not in lib/msgraph. That file reads the client
// secret and hashes with node:crypto; a client component importing one function
// from it would drag both into the browser bundle, which is a build failure at
// best and a leaked secret at worst.

/**
 * 1600 KiB. Graph requires every chunk except the last to be a multiple of
 * 320 KiB and rejects the whole upload otherwise - after the bytes have been
 * sent, which is an expensive way to find out.
 */
export const CHUNK_BYTES = 5 * 320 * 1024;

/** The byte ranges to PUT, in order. Ends are inclusive, as Content-Range wants. */
export function chunkRanges(total: number, chunk = CHUNK_BYTES): { start: number; end: number }[] {
  if (total <= 0) return [];
  const out: { start: number; end: number }[] = [];
  for (let start = 0; start < total; start += chunk) {
    out.push({ start, end: Math.min(start + chunk, total) - 1 });
  }
  return out;
}

/** What Windows and SharePoint will actually accept as a file name. */
export const safeFileName = (name: string): string =>
  (name.replace(/[\\/:*?"<>|#%]/g, "-").replace(/\s+/g, " ").trim() || "packet.pdf").slice(0, 120);
