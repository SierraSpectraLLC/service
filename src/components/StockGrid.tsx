"use client";

import { useState, useTransition } from "react";
import { addStockItems } from "@/app/actions";
import { toCsv } from "@/lib/csv";

type Row = { partNumber: string; name: string; qty: string; minQty: string; bin: string };

const COLUMNS = [
  { key: "partNumber", label: "Part number", width: 140 },
  { key: "name", label: "Description", width: 170 },
  { key: "qty", label: "On hand", width: 70 },
  { key: "minQty", label: "Reorder at", width: 80 },
  { key: "bin", label: "Bin", width: 80 },
] as const;

const blank = (): Row => ({ partNumber: "", name: "", qty: "", minQty: "", bin: "" });
const filled = (r: Row) => !!r.partNumber.trim();

/**
 * Stocking a shelf, spreadsheet-style - the same grid as the catalog and asset
 * entry. An opening count posts as a receive in the ledger; a part number
 * already on the shelf has its description, floor and bin updated rather than
 * being duplicated, so re-pasting a corrected count sheet is safe.
 */
export default function StockGrid({ stockroomId, knownParts, onDone }: {
  stockroomId: number;
  /** Numbers from the parts book, the price book and existing shelves, with
      the book's name where it has one - autocomplete plus description fill. */
  knownParts: { pn: string; name: string }[];
  onDone?: () => void;
}) {
  const [rows, setRows] = useState<Row[]>([blank(), blank(), blank()]);
  const [error, setError] = useState("");
  const [failures, setFailures] = useState<{ row: number; name: string; error: string }[]>([]);
  const [saved, setSaved] = useState("");
  const [pending, startTransition] = useTransition();

  const setCell = (i: number, key: keyof Row, value: string) =>
    setRows((rs) => rs.map((r, n) => {
      if (n !== i) return r;
      const next = { ...r, [key]: value };
      // Typing a number the parts book knows fills the description in, the
      // same way the book fills names on the shelf - one source of truth.
      if (key === "partNumber" && !r.name.trim()) {
        const hit = knownParts.find((p) => p.pn.toLowerCase() === value.trim().toLowerCase());
        if (hit?.name) next.name = hit.name;
      }
      return next;
    }));

  const onPaste = (e: React.ClipboardEvent, atRow: number, atCol: number) => {
    const text = e.clipboardData.getData("text/plain");
    if (!text.includes("\t") && !text.includes("\n")) return;
    e.preventDefault();
    const grid = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").map((l) => l.split("\t"));
    setRows((rs) => {
      const out = [...rs];
      grid.forEach((cells, dr) => {
        const ri = atRow + dr;
        while (out.length <= ri) out.push(blank());
        const row = { ...out[ri] };
        cells.forEach((cell, dc) => {
          const col = COLUMNS[atCol + dc];
          if (col) (row as Record<string, string>)[col.key] = cell.trim();
        });
        out[ri] = row;
      });
      return out;
    });
  };

  const usable = rows.filter(filled);

  const save = () => {
    setError(""); setFailures([]); setSaved("");
    startTransition(async () => {
      const res = await addStockItems(stockroomId, usable);
      if (res?.error) { setError(res.error); return; }
      setFailures(res.failures ?? []);
      const bits = [
        res.created ? `${res.created} new line${res.created === 1 ? "" : "s"}` : "",
        res.updated ? `${res.updated} updated` : "",
      ].filter(Boolean);
      setSaved(bits.join(", ") || "Nothing changed");
      const bad = new Set((res.failures ?? []).map((f) => f.row));
      setRows(bad.size ? usable.filter((_, i) => bad.has(i + 1)) : [blank(), blank(), blank()]);
      if (!bad.size) onDone?.();
    });
  };

  const template = () => toCsv([
    COLUMNS.map((c) => c.label),
    ["228-35145-91", "Plunger seal kit", "4", "2", "A-3"],
    ["5181-3323", "Inlet septa (50pk)", "1", "1", "B-1"],
  ]);

  return (
    <div>
      <div style={{ overflowX: "auto", border: "1px solid var(--line)", borderRadius: 8, background: "#fff" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12, minWidth: 560 }}>
          <thead>
            <tr>
              <th style={{ width: 26 }} />
              {COLUMNS.map((c) => (
                <th key={c.key} style={{ textAlign: "left", padding: "6px 6px", borderBottom: "1px solid var(--line)", fontSize: 11, color: "var(--slate)", width: c.width }}>
                  {c.label}{c.key === "partNumber" && " *"}
                </th>
              ))}
              <th style={{ width: 30 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} style={{ background: filled(r) ? "#FBFDFF" : undefined }}>
                <td className="mut" style={{ fontSize: 10, textAlign: "right", padding: "0 4px" }}>{i + 1}</td>
                {COLUMNS.map((c, ci) => (
                  <td key={c.key} style={{ padding: 2, borderBottom: "1px solid var(--line)" }}>
                    <input value={r[c.key]} aria-label={`${c.label}, row ${i + 1}`}
                      list={c.key === "partNumber" ? "stock-known-parts" : undefined}
                      inputMode={c.key === "qty" || c.key === "minQty" ? "numeric" : undefined}
                      className={c.key === "partNumber" ? "mono" : undefined}
                      onChange={(e) => setCell(i, c.key, e.target.value)}
                      onPaste={(e) => onPaste(e, i, ci)}
                      style={{ width: "100%", fontSize: 12, padding: "3px 4px" }} />
                  </td>
                ))}
                <td style={{ padding: 2, borderBottom: "1px solid var(--line)" }}>
                  {rows.length > 1 && (
                    <button className="btn link" aria-label={`Remove row ${i + 1}`} style={{ color: "#A32D2D", fontSize: 12 }}
                      onClick={() => setRows((rs) => rs.filter((_, n) => n !== i))}>×</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <datalist id="stock-known-parts">{knownParts.map((p) => <option key={p.pn} value={p.pn}>{p.name}</option>)}</datalist>

      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn sm" onClick={() => setRows((rs) => [...rs, blank()])}>＋ Row</button>
        <button className="btn sm" onClick={() => setRows((rs) => [...rs, ...Array.from({ length: 5 }, blank)])}>＋ 5</button>
        <a className="btn link" style={{ fontSize: 12 }}
          href={"data:text/csv;charset=utf-8," + encodeURIComponent(template())}
          download="stock-template.csv">download template</a>
        <span className="mut" style={{ fontSize: 11 }}>Reorder at 0 means never suggest reordering.</span>
        <button className="btn sm accent" style={{ marginLeft: "auto" }} onClick={save} disabled={pending || !usable.length}>
          {pending ? "Saving..." : `Save ${usable.length || ""} line${usable.length === 1 ? "" : "s"}`.replace("  ", " ")}
        </button>
      </div>

      {saved && <div style={{ fontSize: 12, color: "#2E6B2E", fontWeight: 700, marginTop: 8 }}>{saved} ✓</div>}
      {failures.length > 0 && (
        <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>
          {failures.length} row{failures.length === 1 ? "" : "s"} still above:
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {failures.map((f) => <li key={f.row}>{f.name}: {f.error}</li>)}
          </ul>
        </div>
      )}
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{error}</div>}
    </div>
  );
}
