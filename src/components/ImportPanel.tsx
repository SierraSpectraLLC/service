"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { parseCsv } from "@/lib/csv";
import { importFleet, type ImportRow, type ImportRowResult } from "@/app/actions";

const FIELDS = [
  ["", "ignore"],
  ["systemId", "System ID"],
  ["client", "Client / owner"],
  ["category", "Category"],
  ["location", "Location"],
  ["kind", "Asset type"],
  ["model", "Model"],
  ["serial", "Serial"],
  ["manufacturer", "Manufacturer"],
  ["note", "Note"],
] as const;
type FieldKey = (typeof FIELDS)[number][0];

// First guess at the mapping from the header names a spreadsheet is likely to use.
function guessField(header: string): FieldKey {
  const h = header.toLowerCase();
  if (/system|instrument.*id|^id$|asset.*tag/.test(h)) return "systemId";
  if (/client|owner|customer|site/.test(h)) return "client";
  if (/categor/.test(h)) return "category";
  if (/location|room|bench|building/.test(h)) return "location";
  if (/type|kind|module/.test(h)) return "kind";
  if (/model/.test(h)) return "model";
  if (/serial|s\/n|sn\b/.test(h)) return "serial";
  if (/manufacturer|make|brand|vendor/.test(h)) return "manufacturer";
  if (/note|comment|description|status/.test(h)) return "note";
  return "";
}

export default function ImportPanel() {
  const [raw, setRaw] = useState("");
  const [mapping, setMapping] = useState<FieldKey[]>([]);
  const [results, setResults] = useState<ImportRowResult[] | null>(null);
  const [summary, setSummary] = useState("");
  const [phase, setPhase] = useState<"map" | "checked" | "done">("map");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  const grid = useMemo(() => (raw ? parseCsv(raw) : []), [raw]);
  const headers = grid[0] ?? [];
  const body = grid.slice(1);

  const load = (text: string) => {
    setRaw(text);
    setResults(null); setSummary(""); setError(""); setPhase("map");
    const g = parseCsv(text);
    setMapping((g[0] ?? []).map(guessField));
  };

  const toRows = (): ImportRow[] =>
    body.map((cells) => {
      const r: ImportRow = { systemId: "", client: "", category: "", location: "", kind: "", model: "", serial: "", manufacturer: "", note: "" };
      mapping.forEach((f, i) => { if (f) r[f] = (r[f] ? r[f] + " " : "") + (cells[i] ?? "").trim(); });
      return r;
    });

  const run = (dryRun: boolean) => {
    setError(""); setResults(null);
    startTransition(async () => {
      const res = await importFleet(toRows(), dryRun);
      if (res.error) { setError(res.error); return; }
      setResults(res.results ?? []);
      setSummary(`${res.systems} system(s), ${res.assets} asset(s)${dryRun ? " would be created" : " created"}`);
      setPhase(dryRun ? "checked" : "done");
    });
  };

  const problems = (results ?? []).filter((r) => r.error);

  return (
    <div className="card">
      <div className="card-title">Import from a spreadsheet</div>
      <div className="mut" style={{ fontSize: 12, marginBottom: 10 }}>
        Export your sheet as CSV, drop it here, match the columns, check, import. Rows sharing a System ID
        become one system; rows without one become shelf assets.
      </div>

      {!raw && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: "none" }}
            onChange={async (e) => { const f = e.target.files?.[0]; if (f) load(await f.text()); }} />
          <button className="btn sm accent" onClick={() => fileRef.current?.click()}>Choose CSV file</button>
          <a className="btn link" href={"data:text/csv;charset=utf-8," + encodeURIComponent(
            "System ID,Client,Category,Location,Asset type,Model,Serial,Manufacturer,Note\r\nT-001,Acme Labs,LC-MS,Bench 3,Mass spec,LCMS-8050,SN12345,Shimadzu,\r\nT-001,Acme Labs,LC-MS,Bench 3,Pump,LC-40D,SN12346,Shimadzu,\r\n,,,Warehouse,Autosampler,SIL-40C,SN99001,Shimadzu,spare on the shelf\r\n"
          )} download="import-template.csv">download the template</a>
        </div>
      )}

      {raw && phase !== "done" && (
        <>
          <div className="eyebrow" style={{ margin: "6px 0" }}>Column matching · {body.length} data row{body.length === 1 ? "" : "s"}</div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", fontSize: 12, minWidth: 480 }}>
              <thead>
                <tr>
                  {headers.map((h, i) => (
                    <th key={i} style={{ textAlign: "left", padding: "4px 8px 2px", borderBottom: "1px solid var(--line)" }}>
                      <div className="mut" style={{ fontWeight: 400, marginBottom: 2 }}>{h || `column ${i + 1}`}</div>
                      <select value={mapping[i] ?? ""} style={{ width: "auto", fontSize: 11 }}
                        onChange={(e) => setMapping((m) => m.map((f, j) => (j === i ? (e.target.value as FieldKey) : f)))}>
                        {FIELDS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                      </select>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {body.slice(0, 6).map((cells, ri) => (
                  <tr key={ri}>
                    {headers.map((_, ci) => (
                      <td key={ci} style={{ padding: "3px 8px", borderBottom: "1px solid var(--line)", whiteSpace: "nowrap", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" }}>
                        {cells[ci] ?? ""}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {body.length > 6 && <div className="mut" style={{ fontSize: 11, marginTop: 4 }}>...and {body.length - 6} more.</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn sm" onClick={() => run(true)} disabled={pending}>
              {pending ? "Checking..." : "Check (no changes)"}
            </button>
            <button className="btn sm accent" onClick={() => run(false)} disabled={pending || phase !== "checked"}
              title={phase !== "checked" ? "Run the check first" : undefined}>
              {pending ? "Importing..." : "Import"}
            </button>
            <button className="btn link" onClick={() => { setRaw(""); setResults(null); }}>start over</button>
          </div>
        </>
      )}

      {summary && (
        <div style={{ fontSize: 13, fontWeight: 700, marginTop: 10, color: phase === "done" ? "#2E6B2E" : "var(--navy)" }}>
          {summary}{problems.length ? ` · ${problems.length} row(s) need attention` : ""}
        </div>
      )}
      {results && (
        <div style={{ marginTop: 6, maxHeight: 260, overflowY: "auto" }}>
          {(problems.length ? problems : results.slice(0, 30)).map((r) => (
            <div key={r.row} style={{ fontSize: 12, padding: "3px 0", borderTop: "1px solid var(--line)", color: r.error ? "#A32D2D" : "var(--ink)" }}>
              Row {r.row}: {r.action}{r.error ? ` — ${r.error}` : ""}
            </div>
          ))}
          {!problems.length && results.length > 30 && <div className="mut" style={{ fontSize: 11, paddingTop: 4 }}>...and {results.length - 30} more, all fine.</div>}
        </div>
      )}
      {phase === "done" && <a href="/" className="btn sm" style={{ display: "inline-block", marginTop: 10, textDecoration: "none" }}>Go to the dashboard</a>}
      {error && <div style={{ fontSize: 12, color: "#A32D2D", marginTop: 8 }}>{error}</div>}
    </div>
  );
}
