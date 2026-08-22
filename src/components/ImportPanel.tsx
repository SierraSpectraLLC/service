"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { parseCsv } from "@/lib/csv";
import { importFleet, type ImportRow, type ImportRowResult } from "@/app/actions";
import { DataTable, Panel, Pill, RowActions } from "@/components/ui";
import { toast } from "@/components/ui/Toast";

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
  ["owner", "Owner"],
  ["asFound", "As found"],
  ["note", "Note"],
] as const;
type FieldKey = (typeof FIELDS)[number][0];

// First guess at the mapping from the header names a spreadsheet is likely to use.
function guessField(header: string): FieldKey {
  const h = header.toLowerCase();
  if (/system|instrument.*id|^id$|asset.*tag/.test(h)) return "systemId";
  // "Owner" alone is the asset's owner; "client" wording stays the system's.
  if (/^owner/.test(h)) return "owner";
  if (/as.?found|condition/.test(h)) return "asFound";
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

type Step = "upload" | "map" | "preview" | "import";
const STEP_LABEL: Record<Step, string> = {
  upload: "Upload", map: "Map columns", preview: "Preview", import: "Import",
};

/**
 * The Excel off-ramp, walked as four steps: upload the CSV, match its
 * columns, preview what the check makes of every row, import. The step
 * rail is the Dialog's, rendered inline on the page - same classes, same
 * done/warn marks - because this flow IS stepped, it just isn't modal.
 */
export default function ImportPanel() {
  const [raw, setRaw] = useState("");
  const [fileName, setFileName] = useState("");
  const [mapping, setMapping] = useState<FieldKey[]>([]);
  const [results, setResults] = useState<ImportRowResult[] | null>(null);
  const [summary, setSummary] = useState("");
  const [imported, setImported] = useState(false);
  const [step, setStep] = useState<Step>("upload");
  // Data rows the person told the preview to leave out (1-based row numbers).
  const [skipped, setSkipped] = useState<Set<number>>(new Set());
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);

  const grid = useMemo(() => (raw ? parseCsv(raw) : []), [raw]);
  const headers = grid[0] ?? [];
  const body = grid.slice(1);
  const kept = body.filter((_, i) => !skipped.has(i + 1));

  const load = (text: string, name: string) => {
    setRaw(text); setFileName(name);
    setResults(null); setSummary(""); setError(""); setImported(false); setSkipped(new Set());
    const g = parseCsv(text);
    setMapping((g[0] ?? []).map(guessField));
    setStep("map");
  };

  const toRows = (): ImportRow[] =>
    kept.map((cells) => {
      const r: ImportRow = { systemId: "", client: "", category: "", location: "", kind: "", model: "", serial: "", manufacturer: "", note: "", owner: "", asFound: "" };
      mapping.forEach((f, i) => { if (f) r[f] = (r[f] ? r[f] + " " : "") + (cells[i] ?? "").trim(); });
      return r;
    });

  const run = (dryRun: boolean) => {
    setError(""); setResults(null);
    startTransition(async () => {
      const res = await importFleet(toRows(), dryRun);
      if (res.error) { setError(res.error); return; }
      setResults(res.results ?? []);
      const line = `${res.systems} system(s), ${res.assets} asset(s)${dryRun ? " would be created" : " created"}`
        + (res.duplicates ? `, ${res.duplicates} already on file ${dryRun ? "would be" : "were"} skipped` : "");
      setSummary(line);
      if (dryRun) { setStep("preview"); return; }
      setImported(true);
      setStep("import");
      toast({ message: `Imported ${res.systems ?? 0} system${res.systems === 1 ? "" : "s"} and ${res.assets ?? 0} asset${res.assets === 1 ? "" : "s"}` });
    });
  };

  const problems = (results ?? []).filter((r) => r.error);
  const checked = results !== null && !imported;

  // Which steps the rail lets you reach: never forward past what exists.
  const reachable: Record<Step, boolean> = {
    upload: true,
    map: !!raw,
    preview: checked,
    import: imported,
  };
  const steps = (Object.keys(STEP_LABEL) as Step[]).map((k) => ({
    key: k, label: STEP_LABEL[k],
    done: k === "upload" ? !!raw : k === "map" ? checked || imported : k === "preview" ? imported : imported,
    warn: k === "preview" && checked && problems.length > 0,
  }));

  const skipRow = (row: number) => {
    setSkipped((s) => new Set(s).add(row));
    // The numbering the check reported no longer matches the kept rows, so
    // the verdicts are stale by construction: back through the check.
    setResults(null); setSummary("");
    toast({ message: `Skipped row ${row}` });
  };

  return (
    <div className="card" style={{ padding: 0, overflow: "hidden" }}>
      {/* Dialog's step rail, inline. */}
      <div className="dialog-body steps">
        <nav className="dialog-stepnav" aria-label="Import steps">
          {steps.map((s) => (
            <button key={s.key} type="button"
              className={[s.key === step ? "active" : "", s.done ? "done" : "", s.warn ? "warn" : ""].filter(Boolean).join(" ")}
              aria-current={s.key === step ? "step" : undefined}
              disabled={!reachable[s.key]}
              onClick={() => reachable[s.key] && setStep(s.key)}>
              <i aria-hidden="true">{s.done ? "✓" : s.warn ? "!" : ""}</i>
              {s.label}
            </button>
          ))}
        </nav>
        <div className="dialog-progress" aria-hidden="true">
          {steps.map((s) => (
            <span key={s.key} className={s.done ? "done" : s.key === step ? "on" : ""} />
          ))}
        </div>
        <div className="dialog-stepbody" style={{ padding: "14px 18px 16px" }}>

          {step === "upload" && (
            <>
              <div className="mut t-small" style={{ marginBottom: 10 }}>
                Export your sheet as CSV and bring it here. Rows sharing a System ID become one
                system; rows without one become shelf assets.
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <input ref={fileRef} type="file" accept=".csv,text/csv" style={{ display: "none" }}
                  onChange={async (e) => { const f = e.target.files?.[0]; if (f) load(await f.text(), f.name); }} />
                <button className="btn sm accent" onClick={() => fileRef.current?.click()}>Choose CSV file</button>
                <a className="btn link" href={"data:text/csv;charset=utf-8," + encodeURIComponent(
                  "System ID,Client,Category,Location,Asset type,Model,Serial,Manufacturer,Owner,As found,Note\r\nT-001,Acme Labs,LC-MS,Bench 3,Mass spec,LCMS-8050,SN12345,Shimadzu,Acme Labs,,\r\nT-001,Acme Labs,LC-MS,Bench 3,Pump,LC-40D,SN12346,Shimadzu,Acme Labs,leaking seal,\r\n,,,Warehouse,Autosampler,SIL-40C,SN99001,Shimadzu,Acme Labs,,spare on the shelf\r\n"
                )} download="import-template.csv">download the template</a>
              </div>
              {raw && (
                <div className="mut t-small" style={{ marginTop: 10 }}>
                  Loaded: <b>{fileName || "pasted CSV"}</b> · {body.length} data row{body.length === 1 ? "" : "s"}.
                  Choosing another file starts over.
                </div>
              )}
            </>
          )}

          {step === "map" && (
            <>
              <div className="eyebrow" style={{ margin: "0 0 6px" }}>
                Column matching · {kept.length} data row{kept.length === 1 ? "" : "s"}
                {skipped.size > 0 ? ` (${skipped.size} skipped)` : ""}
              </div>
              <div style={{ overflowX: "auto" }}>
                <table className="t-small" style={{ borderCollapse: "collapse", minWidth: 480 }}>
                  <thead>
                    <tr>
                      {headers.map((h, i) => (
                        <th key={i} style={{ textAlign: "left", padding: "4px 8px 2px", borderBottom: "1px solid var(--line)" }}>
                          <div className="mut" style={{ fontWeight: 400, marginBottom: 2 }}>{h || `column ${i + 1}`}</div>
                          <select value={mapping[i] ?? ""} className="t-meta" style={{ width: "auto" }}
                            aria-label={`Field for ${h || `column ${i + 1}`}`}
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
              {body.length > 6 && <div className="mut t-meta" style={{ marginTop: 4 }}>...and {body.length - 6} more.</div>}
              <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
                <button className="btn sm accent" onClick={() => run(true)} disabled={pending}>
                  {pending ? "Checking..." : "Check (no changes)"}
                </button>
                <button className="btn link" onClick={() => { setRaw(""); setResults(null); setStep("upload"); }}>start over</button>
              </div>
            </>
          )}

          {step === "preview" && checked && (
            <>
              <div className="t-body" style={{ fontWeight: 700, marginBottom: 8, color: "var(--navy)" }}>{summary}</div>

              {problems.length > 0 && (
                <div className="card" style={{ borderColor: "var(--t-warn-fg)", background: "var(--t-warn-bg)" }}>
                  <div className="panel-head">
                    <span className="card-title">Needs attention</span>
                    <Pill tone="warn">{problems.length}</Pill>
                  </div>
                  <div className="panel-hint">
                    These rows would not import as they stand. Fix the sheet and re-upload, adjust the
                    mapping, or skip a row and check again.
                  </div>
                  {problems.map((r) => (
                    <div key={r.row} className="row-reveal" style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "5px 0", borderTop: "1px solid var(--line)" }}>
                      <span className="mono t-small" style={{ fontWeight: 700, flexShrink: 0 }}>Row {r.row}</span>
                      <span className="t-small" style={{ minWidth: 0 }}>{r.error}</span>
                      <span style={{ marginLeft: "auto", flexShrink: 0 }}>
                        <RowActions inline={1} menuLabel={`Fixes for row ${r.row}`} items={[
                          { label: "Skip row", onClick: () => { skipRow(r.row); setStep("map"); } },
                          { label: "Fix mapping", onClick: () => setStep("map") },
                        ]} />
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <DataTable
                cols={[
                  { key: "row", label: "Row", width: "64px" },
                  { key: "action", label: "What happens", width: "minmax(180px, 1fr)" },
                  { key: "note", label: "Problem", width: "minmax(140px, 1fr)" },
                ]}
                rows={(results ?? []).map((r) => ({
                  key: r.row,
                  cells: {
                    row: <span className="mono t-small">{r.row}</span>,
                    action: <span style={{ fontSize: 12.5 }}>{r.action}</span>,
                    note: r.error
                      ? <span className="t-small" style={{ color: "var(--t-bad-fg)" }}>{r.error}</span>
                      : <span className="mut t-small">ok</span>,
                  },
                }))}
                empty="The check returned nothing."
              />

              <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center", flexWrap: "wrap" }}>
                <button className="btn sm accent" onClick={() => run(false)} disabled={pending}>
                  {pending ? "Importing..." : `Import ${kept.length} row${kept.length === 1 ? "" : "s"}`}
                </button>
                <button className="btn sm" onClick={() => run(true)} disabled={pending}>
                  {pending ? "Checking..." : "Re-check"}
                </button>
                <button className="btn link" onClick={() => setStep("map")}>back to mapping</button>
              </div>
            </>
          )}

          {step === "preview" && !checked && (
            <div className="mut" style={{ fontSize: 12.5 }}>
              The kept rows changed since the last check.{" "}
              <button className="btn link" onClick={() => run(true)} disabled={pending}>
                {pending ? "Checking..." : "Check again"}
              </button>
            </div>
          )}

          {step === "import" && (
            <>
              <div className="t-body" style={{ fontWeight: 700, marginBottom: 8, color: "var(--t-good-fg)" }}>{summary}</div>
              {results && (
                <div style={{ maxHeight: 260, overflowY: "auto", marginBottom: 10 }}>
                  {results.slice(0, 30).map((r) => (
                    <div key={r.row} className="t-small" style={{ padding: "3px 0", borderTop: "1px solid var(--line)", color: r.error ? "var(--t-bad-fg)" : "var(--ink)" }}>
                      Row {r.row}: {r.action}{r.error ? ` - ${r.error}` : ""}
                    </div>
                  ))}
                  {results.length > 30 && <div className="mut t-meta" style={{ paddingTop: 4 }}>...and {results.length - 30} more.</div>}
                </div>
              )}
              <a href="/" className="btn sm" style={{ display: "inline-block", textDecoration: "none" }}>Go to the dashboard</a>
            </>
          )}

          {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 10 }}>{error}</div>}
        </div>
      </div>
    </div>
  );
}
