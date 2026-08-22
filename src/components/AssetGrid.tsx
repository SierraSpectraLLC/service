"use client";

import { useState, useTransition } from "react";
import { createAssets, type AssetInput } from "@/app/actions";
import { toast } from "@/components/ui/Toast";
import { toCsv } from "@/lib/csv";

/** One catalog model, with the maker so picking a model fills it in. */
export type GridModel = { name: string; manufacturer: string };

type Row = {
  kind: string; model: string; serial: string; manufacturer: string;
  owner: string; location: string; asFound: string; note: string;
};

// The column order IS the CSV template's column order - the grid and the
// downloadable template have to match or the round-trip is a lie.
const COLUMNS = [
  { key: "kind", label: "Type", width: 116 },
  { key: "model", label: "Model", width: 132 },
  { key: "serial", label: "Serial", width: 124, mono: true },
  { key: "manufacturer", label: "Mfr", width: 108 },
  { key: "owner", label: "Owner", width: 108 },
  { key: "location", label: "Location", width: 108 },
  { key: "asFound", label: "As found", width: 124 },
  { key: "note", label: "Notes", width: 150 },
] as const;

const blank = (kind = ""): Row => ({
  kind, model: "", serial: "", manufacturer: "", owner: "", location: "", asFound: "", note: "",
});

const filled = (r: Row) => !!(r.kind.trim() && (r.model.trim() || r.serial.trim()));

/**
 * Spreadsheet-shaped asset entry: a row per unit, a column per field, catalog
 * dropdowns where a value has to come from the catalog. Seven LC modules is one
 * screen and one Save, not seven trips through a form.
 *
 * Paste works: copy a block out of Excel or Sheets and it fills the grid from
 * the focused cell, which is the whole point of matching the template's columns.
 */
export default function AssetGrid({ instrumentId, kinds, models, owners, onDone }: {
  /** Null for shelf stock; a system id installs every row onto it. */
  instrumentId: number | null;
  kinds: string[];
  /** Catalog models per asset type, each with its maker. */
  models: Record<string, GridModel[]>;
  owners: string[];
  onDone?: () => void;
}) {
  const [rows, setRows] = useState<Row[]>([blank(kinds[0] ?? ""), blank(kinds[0] ?? ""), blank(kinds[0] ?? "")]);
  const [error, setError] = useState("");
  const [failures, setFailures] = useState<{ row: number; error: string }[]>([]);
  const [saved, setSaved] = useState("");
  const [pending, startTransition] = useTransition();

  const setCell = (i: number, key: keyof Row, value: string) =>
    setRows((rs) => rs.map((r, n) => {
      if (n !== i) return r;
      const next = { ...r, [key]: value };
      // Picking a catalog model fills the maker in - it's known, so nobody
      // should be typing "Shimadzu" thirty times. A maker already typed stands.
      if (key === "model") {
        const hit = (models[r.kind] ?? []).find((m) => m.name === value);
        if (hit?.manufacturer && !r.manufacturer.trim()) next.manufacturer = hit.manufacturer;
      }
      // Changing the type invalidates the model beneath it.
      if (key === "kind" && value !== r.kind) { next.model = ""; next.manufacturer = ""; }
      return next;
    }));

  /** Excel/Sheets paste: TSV in, rows and columns out, growing the grid to fit. */
  const onPaste = (e: React.ClipboardEvent, atRow: number, atCol: number) => {
    const text = e.clipboardData.getData("text/plain");
    if (!text.includes("\t") && !text.includes("\n")) return; // a single cell: let it paste normally
    e.preventDefault();
    const grid = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n").map((line) => line.split("\t"));
    setRows((rs) => {
      const out = [...rs];
      grid.forEach((cells, dr) => {
        const ri = atRow + dr;
        while (out.length <= ri) out.push(blank(kinds[0] ?? ""));
        const row = { ...out[ri] };
        cells.forEach((cell, dc) => {
          const col = COLUMNS[atCol + dc];
          if (col) (row as Record<string, string>)[col.key] = cell.trim();
        });
        // Re-derive the maker for a pasted model when the paste didn't bring one.
        if (!row.manufacturer.trim()) {
          const hit = (models[row.kind] ?? []).find((m) => m.name.toLowerCase() === row.model.trim().toLowerCase());
          if (hit?.manufacturer) row.manufacturer = hit.manufacturer;
        }
        out[ri] = row;
      });
      return out;
    });
  };

  const usable = rows.filter(filled);

  const save = () => {
    setError(""); setFailures([]); setSaved("");
    startTransition(async () => {
      const res = await createAssets(instrumentId, usable as AssetInput[]);
      if (res?.error) { setError(res.error); return; }
      setFailures(res.failures ?? []);
      setSaved(`${res.created} asset${res.created === 1 ? "" : "s"} added`);
      if (res.created) toast({ message: `Added ${res.created} asset${res.created === 1 ? "" : "s"}` });
      // Keep only the rows that failed, so a fix is a retry rather than a retype.
      const bad = new Set((res.failures ?? []).map((f) => f.row));
      setRows(bad.size
        ? usable.filter((_, i) => bad.has(i + 1))
        : [blank(kinds[0] ?? ""), blank(kinds[0] ?? ""), blank(kinds[0] ?? "")]);
      if (!bad.size) onDone?.();
    });
  };

  const template = () => toCsv([
    COLUMNS.map((c) => c.label),
    ["Mass spec", "LCMS-8050", "123456789", "Shimadzu", "LabZen", "Bench 3", "", ""],
    ["Pump", "LC-20AD", "123654600", "Shimadzu", "LabZen", "Bench 3", "leaking seal", ""],
  ]);

  return (
    <div>
      <div style={{ overflowX: "auto", border: "1px solid var(--line)", borderRadius: 8, background: "#fff" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 12, minWidth: 880 }}>
          <thead>
            <tr>
              <th style={{ width: 26 }} />
              {COLUMNS.map((c) => (
                <th key={c.key} style={{ textAlign: "left", padding: "6px 6px", borderBottom: "1px solid var(--line)", fontSize: 11, color: "var(--slate)", width: c.width }}>
                  {c.label}{(c.key === "kind") && " *"}
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
                    {c.key === "kind" ? (
                      <select value={r.kind} aria-label={`Type, row ${i + 1}`}
                        onChange={(e) => setCell(i, "kind", e.target.value)}
                        style={{ width: "100%", fontSize: 12, padding: "3px 4px" }}>
                        <option value="">-</option>
                        {kinds.map((k) => <option key={k}>{k}</option>)}
                      </select>
                    ) : c.key === "model" ? (
                      <>
                        {/* A catalog list, but typed entry still lands - the
                            catalog is the source, not a cage, and a unit in
                            front of you always gets recorded. */}
                        <input value={r.model} list={`grid-models-${r.kind}`} aria-label={`Model, row ${i + 1}`}
                          onChange={(e) => setCell(i, "model", e.target.value)}
                          onPaste={(e) => onPaste(e, i, ci)}
                          style={{ width: "100%", fontSize: 12, padding: "3px 4px" }} />
                        <datalist id={`grid-models-${r.kind}`}>
                          {(models[r.kind] ?? []).map((m) => (
                            <option key={m.name} value={m.name}>{m.manufacturer}</option>
                          ))}
                        </datalist>
                      </>
                    ) : c.key === "owner" ? (
                      <input value={r.owner} list="grid-owners" aria-label={`Owner, row ${i + 1}`}
                        onChange={(e) => setCell(i, "owner", e.target.value)}
                        onPaste={(e) => onPaste(e, i, ci)}
                        style={{ width: "100%", fontSize: 12, padding: "3px 4px" }} />
                    ) : (
                      <input value={r[c.key]} aria-label={`${c.label}, row ${i + 1}`}
                        className={"mono" in c && c.mono ? "mono" : undefined}
                        onChange={(e) => setCell(i, c.key, e.target.value)}
                        onPaste={(e) => onPaste(e, i, ci)}
                        style={{ width: "100%", fontSize: 12, padding: "3px 4px" }} />
                    )}
                  </td>
                ))}
                <td style={{ padding: 2, borderBottom: "1px solid var(--line)" }}>
                  {rows.length > 1 && (
                    <button className="btn link t-small" aria-label={`Remove row ${i + 1}`} style={{ color: "var(--t-bad-fg)" }}
                      onClick={() => setRows((rs) => rs.filter((_, n) => n !== i))}>×</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <datalist id="grid-owners">{owners.map((o) => <option key={o} value={o} />)}</datalist>

      <div className="row-2" style={{ marginTop: 8 }}>
        <button className="btn sm" onClick={() => setRows((rs) => [...rs, blank(kinds[0] ?? "")])}>＋ Row</button>
        <button className="btn sm" onClick={() => setRows((rs) => [...rs, ...Array.from({ length: 5 }, () => blank(kinds[0] ?? ""))])}>＋ 5</button>
        <a className="btn link t-small"
          href={"data:text/csv;charset=utf-8," + encodeURIComponent(template())}
          download="assets-template.csv">download template</a>
        <span className="mut t-meta">
          Paste a block from a spreadsheet into any cell - same columns, in order.
        </span>
        <button className="btn sm accent" style={{ marginLeft: "auto" }} onClick={save} disabled={pending || !usable.length}>
          {pending ? "Saving..." : `Save ${usable.length || ""} asset${usable.length === 1 ? "" : "s"}`.replace("  ", " ")}
        </button>
      </div>

      {saved && <div className="t-small" style={{ color: "var(--t-good-fg)", fontWeight: 700, marginTop: 8 }}>{saved} ✓</div>}
      {failures.length > 0 && (
        <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>
          {failures.length} row{failures.length === 1 ? "" : "s"} could not be saved and {failures.length === 1 ? "is" : "are"} still above:
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {failures.map((f) => <li key={f.row}>Row {f.row}: {f.error}</li>)}
          </ul>
        </div>
      )}
      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}
    </div>
  );
}
