"use client";

import { useState, useTransition } from "react";
import { addVocabTerms } from "@/app/actions";
import { toCsv } from "@/lib/csv";

type Row = { assetType: string; name: string; manufacturer: string; categories: string };

// Same idea as the asset grid: the column order is the template's column order.
const COLUMNS = [
  { key: "assetType", label: "Module type", width: 130 },
  { key: "name", label: "Model", width: 150 },
  { key: "manufacturer", label: "Manufacturer", width: 130 },
  { key: "categories", label: "System types", width: 170 },
] as const;

const blank = (assetType = "", categories = ""): Row => ({ assetType, name: "", manufacturer: "", categories });

const filled = (r: Row) => !!(r.assetType.trim() && r.name.trim());

/**
 * Spreadsheet entry for the catalog. Filling in thirty pumps across seven
 * makers one input at a time is the same problem the asset grid solved, so it
 * gets the same answer: a row per model, Excel paste, one Save.
 *
 * System types are comma-separated in a single cell - a model can belong to
 * several, and empty still means "every system type".
 */
export default function CatalogGrid({ assetTypes, categoryNames, knownMakers, defaultCategory, onDone }: {
  assetTypes: string[];
  categoryNames: string[];
  knownMakers: string[];
  /** Prefilled when the grid is opened from inside one system type's section. */
  defaultCategory?: string;
  onDone?: () => void;
}) {
  const seed = () => blank(assetTypes[0] ?? "", defaultCategory ?? "");
  const [rows, setRows] = useState<Row[]>([seed(), seed(), seed()]);
  const [error, setError] = useState("");
  const [failures, setFailures] = useState<{ row: number; name: string; error: string }[]>([]);
  const [saved, setSaved] = useState("");
  const [pending, startTransition] = useTransition();

  const setCell = (i: number, key: keyof Row, value: string) =>
    setRows((rs) => rs.map((r, n) => (n === i ? { ...r, [key]: value } : r)));

  /** Excel/Sheets paste: TSV in, rows and columns out, growing the grid to fit. */
  const onPaste = (e: React.ClipboardEvent, atRow: number, atCol: number) => {
    const text = e.clipboardData.getData("text/plain");
    if (!text.includes("\t") && !text.includes("\n")) return;
    e.preventDefault();
    const grid = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").map((l) => l.split("\t"));
    setRows((rs) => {
      const out = [...rs];
      grid.forEach((cells, dr) => {
        const ri = atRow + dr;
        while (out.length <= ri) out.push(seed());
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
      const res = await addVocabTerms(usable.map((r) => ({
        kind: "model", assetType: r.assetType, name: r.name, manufacturer: r.manufacturer,
        categories: r.categories.split(",").map((c) => c.trim()).filter(Boolean),
      })));
      if (res?.error) { setError(res.error); return; }
      setFailures(res.failures ?? []);
      setSaved(`${res.created} model${res.created === 1 ? "" : "s"} added`);
      const bad = new Set((res.failures ?? []).map((f) => f.row));
      setRows(bad.size ? usable.filter((_, i) => bad.has(i + 1)) : [seed(), seed(), seed()]);
      if (!bad.size) onDone?.();
    });
  };

  const template = () => toCsv([
    COLUMNS.map((c) => c.label),
    ["Pump", "LC-20AD", "Shimadzu", "LC-MS"],
    ["Pump", "LC-20ADXR", "Shimadzu", "LC-MS"],
    ["Detector", "FID", "Agilent", "GC-MS"],
  ]);

  return (
    <div>
      <div style={{ overflowX: "auto", border: "1px solid var(--line)", borderRadius: 8, background: "#fff" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12, minWidth: 580 }}>
          <thead>
            <tr>
              <th style={{ width: 26 }} />
              {COLUMNS.map((c) => (
                <th key={c.key} style={{ textAlign: "left", padding: "6px 6px", borderBottom: "1px solid var(--line)", fontSize: 11, color: "var(--slate)", width: c.width }}>
                  {c.label}{(c.key === "assetType" || c.key === "name") && " *"}
                </th>
              ))}
              <th style={{ width: 30 }} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} style={{ background: filled(r) ? "#FBFDFF" : undefined }}>
                <td className="mut" style={{ fontSize: 10, textAlign: "right", padding: "0 4px" }}>{i + 1}</td>
                <td style={{ padding: 2, borderBottom: "1px solid var(--line)" }}>
                  <select value={r.assetType} aria-label={`Module type, row ${i + 1}`}
                    onChange={(e) => setCell(i, "assetType", e.target.value)}
                    style={{ width: "100%", fontSize: 12, padding: "3px 4px" }}>
                    <option value="">-</option>
                    {assetTypes.map((t) => <option key={t}>{t}</option>)}
                  </select>
                </td>
                <td style={{ padding: 2, borderBottom: "1px solid var(--line)" }}>
                  <input value={r.name} aria-label={`Model, row ${i + 1}`}
                    onChange={(e) => setCell(i, "name", e.target.value)}
                    onPaste={(e) => onPaste(e, i, 1)}
                    style={{ width: "100%", fontSize: 12, padding: "3px 4px" }} />
                </td>
                <td style={{ padding: 2, borderBottom: "1px solid var(--line)" }}>
                  <input value={r.manufacturer} list="catalog-makers" aria-label={`Manufacturer, row ${i + 1}`}
                    onChange={(e) => setCell(i, "manufacturer", e.target.value)}
                    onPaste={(e) => onPaste(e, i, 2)}
                    style={{ width: "100%", fontSize: 12, padding: "3px 4px" }} />
                </td>
                <td style={{ padding: 2, borderBottom: "1px solid var(--line)" }}>
                  <input value={r.categories} list="catalog-systemtypes" aria-label={`System types, row ${i + 1}`}
                    placeholder="all system types"
                    onChange={(e) => setCell(i, "categories", e.target.value)}
                    onPaste={(e) => onPaste(e, i, 3)}
                    style={{ width: "100%", fontSize: 12, padding: "3px 4px" }} />
                </td>
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
      <datalist id="catalog-systemtypes">{categoryNames.map((c) => <option key={c} value={c} />)}</datalist>
      {/* The maker list is also rendered by CatalogForm; a duplicate id is
          harmless and keeps this component usable on its own. */}
      <datalist id="catalog-makers">{knownMakers.map((m) => <option key={m} value={m} />)}</datalist>

      <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
        <button className="btn sm" onClick={() => setRows((rs) => [...rs, seed()])}>＋ Row</button>
        <button className="btn sm" onClick={() => setRows((rs) => [...rs, ...Array.from({ length: 5 }, seed)])}>＋ 5</button>
        <a className="btn link" style={{ fontSize: 12 }}
          href={"data:text/csv;charset=utf-8," + encodeURIComponent(template())}
          download="catalog-template.csv">download template</a>
        <span className="mut" style={{ fontSize: 11 }}>Paste a block from a spreadsheet into any cell.</span>
        <button className="btn sm accent" style={{ marginLeft: "auto" }} onClick={save} disabled={pending || !usable.length}>
          {pending ? "Saving..." : `Save ${usable.length || ""} model${usable.length === 1 ? "" : "s"}`.replace("  ", " ")}
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
