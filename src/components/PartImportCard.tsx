"use client";

import { useRef, useState, useTransition } from "react";
import { importParts } from "@/app/actions";
import { parseCsv, toCsv } from "@/lib/csv";
import {
  COLUMNS, checkRows, readGrid, summarize, templateGrid,
  type PartImportRow, type RowProblem,
} from "@/lib/partImport";
import { Panel } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

/**
 * A whole parts sheet, in one go.
 *
 * Three steps, in the order somebody actually does them: get the shape (the
 * template), put the sheet in (a file or a paste), LOOK at what it read, then
 * save. The look is not ceremony - a mis-mapped column is invisible in a CSV
 * and obvious in a table, and this writes to the catalog every price in the
 * shop is matched against.
 */
export default function PartImportCard({ downloadName }: { downloadName: string }) {
  const [rows, setRows] = useState<PartImportRow[] | null>(null);
  const [problems, setProblems] = useState<RowProblem[]>([]);
  const [saving, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pasted, setPasted] = useState("");

  const take = (text: string) => {
    // Tab-separated is what a paste out of Excel is; comma is what a file is.
    // Sniffing beats asking, and getting it wrong shows up in the preview.
    const grid = text.includes("\t")
      ? text.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split("\t"))
      : parseCsv(text);
    const read = readGrid(grid);
    const { problems: found } = checkRows(read);
    setRows(read);
    setProblems(found);
    if (!read.length) toast({ message: "Nothing readable on that sheet", tone: "bad" });
  };

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    take(await f.text());
  };

  const save = () => {
    if (!rows?.length) return;
    start(async () => {
      const res = await importParts(rows);
      if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
      const bits = [
        res.created ? `${res.created} new` : "",
        res.updated ? `${res.updated} updated` : "",
        res.prices ? `${res.prices} price${res.prices === 1 ? "" : "s"}` : "",
      ].filter(Boolean).join(", ");
      toast({ message: bits ? `Imported: ${bits}` : "Nothing changed" });
      setProblems(res.problems ?? []);
      // The rows are gone but the problems stay on screen: a summary that
      // disappears with the thing it is about is a summary nobody can act on.
      setRows(null);
      setPasted("");
      if (fileRef.current) fileRef.current.value = "";
    });
  };

  const counts = rows ? summarize(rows) : null;

  return (
    <Panel
      title="Import parts"
      actions={
        <>
          {/* Export first, deliberately: for a catalog with anything in it the
              honest starting point is what is already there, not a blank
              template - fewer people retype a description that exists. */}
          <a className="btn sm" href="/api/export/parts">Export what is on file</a>
          <a className="btn sm" download={`${downloadName}-template.csv`}
            href={"data:text/csv;charset=utf-8," + encodeURIComponent(toCsv(templateGrid()))}>
            Download template
          </a>
        </>
      }
    >
      <div className="t-body" style={{ marginBottom: 10 }}>
        One line per part. A part sold by three vendors is three lines with the
        same part number - that is how it gets three prices, not a clash.
        {" "}<b>A blank cell leaves what is on file alone</b>, so a sheet of
        nothing but prices will not wipe descriptions somebody wrote by hand.
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <input ref={fileRef} type="file" accept=".csv,text/csv" className="t-small"
          aria-label="Choose a CSV file"
          onChange={(e) => onFile(e.target.files?.[0])} />
      </div>
      <div className="field" style={{ marginBottom: 10 }}>
        <label htmlFor="parts-paste">...or paste straight out of a spreadsheet</label>
        <textarea id="parts-paste" rows={3} value={pasted}
          placeholder="Part number	Name	Manufacturer	..."
          onChange={(e) => setPasted(e.target.value)}
          onBlur={() => pasted.trim() && take(pasted)} />
      </div>

      {counts && rows && rows.length > 0 && (
        <>
          {/* The count says what the sheet IS before anybody commits to it.
              Eighty lines reads as alarming until it reads as twenty parts with
              four vendors each, which is what a quote comparison looks like. */}
          <div className="t-body" style={{ marginBottom: 8 }}>
            <b>{counts.parts}</b> part{counts.parts === 1 ? "" : "s"}
            {counts.prices > 0 && <> and <b>{counts.prices}</b> vendor price{counts.prices === 1 ? "" : "s"}</>}
            {" "}on {rows.length} line{rows.length === 1 ? "" : "s"}.
          </div>
          <div style={{ overflowX: "auto", border: "1px solid var(--line)", borderRadius: 8 }}>
            <table className="t-small" style={{ borderCollapse: "collapse", minWidth: "100%" }}>
              <thead>
                <tr>{COLUMNS.map((c) => (
                  <th key={c.key} style={{ textAlign: "left", padding: "5px 8px", whiteSpace: "nowrap", borderBottom: "1px solid var(--line)" }}>
                    {c.header.split("(")[0].trim()}
                  </th>
                ))}</tr>
              </thead>
              <tbody>
                {rows.slice(0, 20).map((r, i) => (
                  <tr key={i}>{COLUMNS.map((c) => (
                    <td key={c.key} style={{ padding: "4px 8px", whiteSpace: "nowrap", borderTop: "1px solid var(--line)" }}>
                      {r[c.key]}
                    </td>
                  ))}</tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows.length > 20 && (
            <div className="mut t-meta" style={{ marginTop: 5 }}>
              Showing the first 20 of {rows.length}. All of them import.
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button className="btn primary" disabled={saving} onClick={save}>
              {saving ? "Importing…" : `Import ${counts.parts} part${counts.parts === 1 ? "" : "s"}`}
            </button>
            <button className="btn" disabled={saving} onClick={() => { setRows(null); setPasted(""); setProblems([]); }}>
              Discard
            </button>
          </div>
        </>
      )}

      {problems.length > 0 && (
        /* Listed by line, because the fix happens in their spreadsheet and a
           line number is the only address that means anything there. */
        <div className="t-small" style={{ marginTop: 10, padding: "8px 10px", borderRadius: 8, background: "var(--t-warn-bg)", color: "var(--t-warn-fg)" }}>
          <b>{problems.length} line{problems.length === 1 ? "" : "s"} skipped.</b>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {problems.slice(0, 10).map((p, i) => (
              <li key={i}>Line {p.line}{p.partNumber ? ` (${p.partNumber})` : ""} - {p.problem}</li>
            ))}
          </ul>
          {problems.length > 10 && <div style={{ marginTop: 4 }}>...and {problems.length - 10} more.</div>}
        </div>
      )}
    </Panel>
  );
}
