// Minimal, dependency-free CSV for the Excel migration path. Handles what real
// spreadsheet exports actually contain: quoted fields, doubled quotes, commas
// and newlines inside quotes, CRLF endings, and a UTF-8 BOM. Deliberately not
// configurable - comma-separated, first row is headers.

export function parseCsv(text: string): string[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // strip BOM
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  // Spreadsheets love trailing blank lines; a row of empty cells says nothing.
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

const needsQuoting = /[",\n\r]/;

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((r) =>
    r.map((cell) => {
      const v = cell == null ? "" : String(cell);
      return needsQuoting.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
    }).join(",")
  ).join("\r\n") + "\r\n";
}
