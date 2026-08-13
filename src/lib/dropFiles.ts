// Which of the things somebody just dragged in are PDFs.
//
// Dropping a folder, a screenshot and three PDFs together is the normal case,
// not the careless one, so the answer is a split rather than a filter: the PDFs
// to open, and the names of everything else to say out loud. Silently ignoring
// half a drop is how somebody ends up assembling a packet that is missing a
// page and not knowing why.
//
// Pure, so the rule that decides what counts can be argued with in a test
// instead of by dragging files at a browser.

export type DroppedLike = { name: string; type: string };

/** Both signals, because either can be missing. Windows often supplies no MIME
 *  type for a file dragged out of Explorer, and a PDF renamed .txt is not one. */
const isPdf = (f: DroppedLike) =>
  f.type === "application/pdf" || /\.pdf$/i.test(f.name ?? "");

export type DropSplit<T> = { pdfs: T[]; rejected: string[] };

export function splitDropped<T extends DroppedLike>(files: T[]): DropSplit<T> {
  const pdfs: T[] = [];
  const rejected: string[] = [];
  for (const f of files) {
    if (isPdf(f)) pdfs.push(f);
    // A folder arrives as an entry with no type and no extension. Naming it is
    // more use than a generic "some files were skipped".
    else rejected.push(f.name || "an unnamed item");
  }
  return { pdfs, rejected };
}

/** What to tell somebody who dropped things that could not be opened. */
export function rejectedMessage(rejected: string[]): string {
  if (!rejected.length) return "";
  const shown = rejected.slice(0, 3).join(", ");
  const more = rejected.length > 3 ? ` and ${rejected.length - 3} more` : "";
  return `Only PDFs can be added here - skipped ${shown}${more}.`;
}

/** Is this drag carrying files from outside the page, rather than a page tile? */
export const isFileDrag = (types: readonly string[] | undefined): boolean =>
  (types ?? []).includes("Files");
