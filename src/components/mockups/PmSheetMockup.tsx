"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Pill } from "@/components/ui";
import type { NotesRecord, ServiceReport } from "@/lib/serviceReport";

/**
 * MOCKUP - the PM sheet: one card per job, laid out like the paper, instead of
 * a task per reading. Nothing here is saved; it exists to be clicked through
 * before the real thing is built. The Preview PDF button runs the real report
 * generator on whatever was typed, so the printout is not a mock.
 */

type Reading = { id: number; label: string; value: string; verdict: "" | "OK" | "FAIL"; limit?: { op: "lte" | "gte"; v: number; unit: string } };
type Check = { id: number; label: string; done: boolean };
type Row = { id: number; point: string; value: string; verdict: "" | "Pass" | "Fail" };
type Table = { id: number; title: string; cols: [string, string]; rows: Row[] };
type Sheet = { name: string; readings: Reading[]; checks: Check[]; tables: Table[] };

let seq = 1;
const nid = () => seq++;

/** The saved layout for this model - what "Start from" hands you, every value blank. */
function quattroSheet(): Sheet {
  const rows = (pts: string[]) => pts.map((point) => ({ id: nid(), point, value: "", verdict: "" as const }));
  return {
    name: "Waters Quattro Ultima PM",
    readings: [
      { id: nid(), label: "Collision Cell w/Collision Gas", value: "", verdict: "", limit: { op: "lte", v: 5e-3, unit: "" } },
      { id: nid(), label: "Analyzer Penning w/ Collision Gas", value: "", verdict: "", limit: { op: "lte", v: 5e-5, unit: "" } },
      { id: nid(), label: "Source CID On", value: "", verdict: "" },
      { id: nid(), label: "Analyzer CID On", value: "", verdict: "" },
      { id: nid(), label: "Source CID Off", value: "", verdict: "" },
      { id: nid(), label: "Analyzer CID Off", value: "", verdict: "" },
    ],
    checks: [
      "Checked for front-end contamination", "Replaced Air Filter", "Cleaned Source & RF Lens",
      "Replaced Capillary & O-Rings", "Tightened all vacuum and electrical connections", "Pump down minimum 60 mins",
    ].map((label) => ({ id: nid(), label, done: false })),
    tables: [
      { id: nid(), title: "Positive Scan Mode - MS1", cols: ["Mass (Da)", "m/z Intensity Measured"], rows: rows(["132.9", "172.9", "622.6", "1971.6"]) },
      { id: nid(), title: "Positive Scan Mode - MS2", cols: ["Mass (Da)", "m/z Intensity Measured"], rows: rows(["132.9", "172.9", "622.6", "1971.6"]) },
      { id: nid(), title: "Positive Scan Mode - MRM", cols: ["Mass (Da)", "m/z Intensity Measured"], rows: rows(["172.8"]) },
    ],
  };
}

const blankSheet = (): Sheet => ({ name: "New sheet", readings: [], checks: [], tables: [] });

/** A reading with a limit judges itself; one without takes the engineer's word. */
function judged(r: Reading): Reading["verdict"] {
  if (!r.limit) return r.verdict;
  const n = parseFloat((r.value.match(/-?\d*\.?\d+(?:[eE][-+]?\d+)?/) ?? [""])[0]);
  if (!Number.isFinite(n)) return "";
  return (r.limit.op === "lte" ? n <= r.limit.v : n >= r.limit.v) ? "OK" : "FAIL";
}
const limitLabel = (l: NonNullable<Reading["limit"]>) => `${l.op === "lte" ? "≤" : "≥"} ${l.v.toExponential(1)}${l.unit ? ` ${l.unit}` : ""}`;

export default function PmSheetMockup() {
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState("");
  const [date, setDate] = useState("2026-10-19");

  const up = (f: (s: Sheet) => Sheet) => setSheet((s) => (s ? f(structuredClone(s)) : s));

  const progress = useMemo(() => {
    if (!sheet) return { done: 0, total: 0 };
    const cells = [
      ...sheet.readings.map((r) => Boolean(r.value.trim() && judged(r))),
      ...sheet.checks.map((c) => c.done),
      ...sheet.tables.flatMap((t) => t.rows.map((r) => Boolean(r.value.trim() && r.verdict))),
    ];
    return { done: cells.filter(Boolean).length, total: cells.length };
  }, [sheet]);
  const fails = sheet
    ? sheet.readings.filter((r) => judged(r) === "FAIL").length + sheet.tables.flatMap((t) => t.rows).filter((r) => r.verdict === "Fail").length
    : 0;

  const preview = async () => {
    if (!sheet) return;
    const { buildServiceReport } = await import("@/lib/serviceReport");
    const record: NotesRecord = { checks: [], tables: [] };
    const read = sheet.readings.filter((r) => r.value.trim());
    if (read.length) {
      record.checks.push({ kind: "heading", text: "PM Validation Checks" });
      for (const r of read) record.checks.push({ kind: "reading", text: `${r.label}: ${r.value.trim()}${judged(r) ? ` ${judged(r)}` : ""}` });
      record.checks.push({ kind: "gap", text: "" });
    }
    for (const c of sheet.checks) record.checks.push({ kind: "box", text: c.label, done: c.done });
    for (const t of sheet.tables) {
      const rows = t.rows.filter((r) => r.value.trim()).map((r) => [r.point, r.value, r.verdict] as [string, string, string]);
      if (rows.length) record.tables.push({ title: t.title, cols: t.cols, rows });
    }
    const report: ServiceReport = {
      reportNumber: "DRAFT", date, visitDate: date, serviceType: "PM", visitNumber: "01", engineer: "Joe Harris",
      provider: { name: "Sierra Spectra, LLC.", lines: ["2393 Anglers Ct", "Mariposa, CA 95338"] },
      customer: { name: "UCSF - HAL", lines: ["580 Parnassus Ave.,", "RM# S920", "San Francisco, CA 94143"] },
      instrument: { type: "Waters Quattro Ultima MS", model: "Quattro Ultima", serial: "VC389" },
      workCompleted: "Performed PM on Q. Ultima", poNumber: "030182_Ar2",
      request: { date: "2026-10-12", from: "Weaver, Alexa", text: "PM Request" },
      notes: { date, body: "" }, record,
      calibration: [], parts: [], labor: [],
      balances: { visitsRemaining: "-", partsRemaining: "-", partsTotal: "-" }, adjustmentCents: 0,
      signatures: { providerName: "Joe Harris", customerName: "", customerOrg: "UCSF", providerOrg: "Sierra Spectra" },
      contact: "Sierra Spectra | +1 (209) 703-0583 | jrharris@sierraspectra.com",
    };
    const bytes = await buildServiceReport(report);
    window.open(URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/pdf" })), "_blank");
  };

  const x = (onClick: () => void, label: string) => (
    <button type="button" className="btn link danger" aria-label={label} title={label} onClick={onClick}>×</button>
  );

  return (
    <div className="container wide">
      <div className="card" style={{ background: "var(--t-warn-bg)", marginBottom: 12 }}>
        <b>Mockup.</b> <span className="t-small">Nothing here is saved, and the job is sample data. Preview PDF runs the real
        report generator on whatever you type. <Link href="/work">Back to work orders</Link></span>
      </div>

      <div className="crumb">Work orders › <b>WO-1042</b></div>
      <div className="card" style={{ marginBottom: 12 }}>
        <div className="eyebrow">Asked by UCSF - HAL · Weaver, Alexa</div>
        <div className="row-2" style={{ alignItems: "baseline", flexWrap: "wrap" }}>
          <span className="mono">WO-1042</span>
          <span className="card-title">Annual PM on Quattro Ultima</span>
        </div>
        <div className="mut t-small">VC389 · Waters Quattro Ultima MS · with Joe Harris</div>
      </div>

      {/* ── No sheet yet: pick one ─────────────────────────────────────── */}
      {!sheet && (
        <div className="card">
          <div className="card-title">PM sheet</div>
          <div className="mut t-small" style={{ marginBottom: 12 }}>
            The readings, checks and tables you fill in on site. They print in the Service Engineer Notes box of the report.
          </div>
          <button type="button" className="btn" onClick={() => setSheet(quattroSheet())}
            style={{ display: "block", width: "100%", textAlign: "left", padding: 12, marginBottom: 8 }}>
            <b>Waters Quattro Ultima PM</b> <Pill tone="info">for this model</Pill>
            <div className="mut t-small">6 readings · 6 checks · 3 tables · last used on WO-0981, Jan 15</div>
          </button>
          <button type="button" className="btn" onClick={() => { setSheet(blankSheet()); setEditing(true); }}
            style={{ display: "block", width: "100%", textAlign: "left", padding: 12 }}>
            <b>Start blank</b>
            <div className="mut t-small">Lay out a new sheet. You can save it for this model when you&apos;re done.</div>
          </button>
        </div>
      )}

      {/* ── The sheet ──────────────────────────────────────────────────── */}
      {sheet && (
        <div className="card">
          <div className="row-2" style={{ alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <div style={{ flex: 1, minWidth: 200 }}>
              <div className="card-title">PM sheet</div>
              <div className="mut t-small">{sheet.name}{editing ? " · editing the layout" : ""}</div>
            </div>
            {!editing && (
              <span className="t-small" aria-live="polite">
                <b>{progress.done}</b> of {progress.total} filled
                {fails > 0 && <> · <Pill tone="bad">{fails} fail{fails === 1 ? "" : "s"}</Pill></>}
              </span>
            )}
            <div className="seg" role="group" aria-label="Mode">
              <button type="button" aria-pressed={!editing} onClick={() => setEditing(false)}>Fill in</button>
              <button type="button" aria-pressed={editing} onClick={() => { setEditing(true); setSaved(""); }}>Edit layout</button>
            </div>
          </div>
          {!editing && progress.total > 0 && (
            <div className="meter-track" style={{ marginTop: 8 }}>
              <div className="meter-fill" style={{ background: "var(--navy)", width: `${(100 * progress.done) / progress.total}%` }} />
            </div>
          )}

          <div className="row-2" style={{ marginTop: 12, alignItems: "center", gap: 8 }}>
            <span className="eyebrow">Service Engineer Notes · Date</span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" style={{ width: "auto" }} />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 24, marginTop: 12 }}>
            {/* Left: readings, then the checklist */}
            <div>
              <div className="eyebrow" style={{ marginBottom: 4 }}>PM Validation Checks</div>
              {sheet.readings.map((r, i) => {
                const v = judged(r);
                return (
                  <div key={r.id} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 8, alignItems: "center", padding: "4px 0", borderTop: "1px solid var(--line)" }}>
                    {editing ? (
                      <input value={r.label} aria-label="Reading name"
                        onChange={(e) => up((s) => { s.readings[i].label = e.target.value; return s; })} />
                    ) : (
                      <span className="t-body">
                        {r.label}
                        {r.limit && <span className="mut t-meta" style={{ display: "block" }}>passes {limitLabel(r.limit)}</span>}
                      </span>
                    )}
                    <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
                    {!editing && (
                      <>
                        <input value={r.value} inputMode="decimal" placeholder="reading" aria-label={`${r.label} reading`}
                          className="mono" style={{ width: 96 }}
                          onChange={(e) => up((s) => { s.readings[i].value = e.target.value; return s; })} />
                        {r.limit ? (
                          <span style={{ width: 88, textAlign: "center" }}>{v ? <Pill tone={v === "OK" ? "good" : "bad"}>{v}</Pill> : <span className="mut t-meta">auto</span>}</span>
                        ) : (
                          <div className="seg" role="group" aria-label={`${r.label} verdict`}>
                            {(["OK", "FAIL"] as const).map((o) => (
                              <button key={o} type="button" aria-pressed={r.verdict === o}
                                onClick={() => up((s) => { s.readings[i].verdict = s.readings[i].verdict === o ? "" : o; return s; })}>{o}</button>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                    {editing && (
                      <>
                        <select value={r.limit ? r.limit.op : ""} aria-label="How it is judged" style={{ width: "auto" }}
                          onChange={(e) => up((s) => {
                            const op = e.target.value;
                            s.readings[i].limit = op ? { op: op as "lte" | "gte", v: s.readings[i].limit?.v ?? 0, unit: "" } : undefined;
                            return s;
                          })}>
                          <option value="">I mark OK / FAIL</option>
                          <option value="lte">OK when ≤ a limit</option>
                          <option value="gte">OK when ≥ a limit</option>
                        </select>
                        {r.limit && (
                          <input defaultValue={String(r.limit.v)} aria-label="Limit" className="mono" style={{ width: 88 }}
                            onBlur={(e) => up((s) => { s.readings[i].limit!.v = parseFloat(e.target.value) || 0; return s; })} />
                        )}
                        {x(() => up((s) => { s.readings.splice(i, 1); return s; }), `Remove ${r.label}`)}
                      </>
                    )}
                    </span>
                  </div>
                );
              })}
              {editing && (
                <button type="button" className="btn sm" style={{ marginTop: 4 }}
                  onClick={() => up((s) => { s.readings.push({ id: nid(), label: "New reading", value: "", verdict: "" }); return s; })}>
                  ＋ Reading
                </button>
              )}

              <div className="eyebrow" style={{ marginTop: 16, marginBottom: 4 }}>Checklist</div>
              {sheet.checks.map((c, i) => (
                <div key={c.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0", borderTop: "1px solid var(--line)" }}>
                  {editing ? (
                    <>
                      <input value={c.label} aria-label="Check" style={{ flex: 1 }}
                        onChange={(e) => up((s) => { s.checks[i].label = e.target.value; return s; })} />
                      {x(() => up((s) => { s.checks.splice(i, 1); return s; }), `Remove ${c.label}`)}
                    </>
                  ) : (
                    <label className="t-body" style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer", flex: 1, margin: 0, padding: "4px 0" }}>
                      <input type="checkbox" checked={c.done} style={{ width: 20, height: 20 }}
                        onChange={() => up((s) => { s.checks[i].done = !s.checks[i].done; return s; })} />
                      {c.label}
                    </label>
                  )}
                </div>
              ))}
              {!editing && sheet.checks.length > 0 && (
                <button type="button" className="btn link" style={{ marginTop: 4 }}
                  onClick={() => up((s) => { s.checks.forEach((c) => { c.done = true; }); return s; })}>Tick all</button>
              )}
              {editing && (
                <button type="button" className="btn sm" style={{ marginTop: 4 }}
                  onClick={() => up((s) => { s.checks.push({ id: nid(), label: "New check", done: false }); return s; })}>
                  ＋ Check
                </button>
              )}
            </div>

            {/* Right: the tables */}
            <div>
              {sheet.tables.map((t, ti) => (
                <div key={t.id} style={{ marginBottom: 16 }}>
                  <div className="row-2" style={{ alignItems: "center", gap: 8 }}>
                    {editing ? (
                      <>
                        <input value={t.title} aria-label="Table title" style={{ flex: 1, fontWeight: 700 }}
                          onChange={(e) => up((s) => { s.tables[ti].title = e.target.value; return s; })} />
                        {x(() => up((s) => { s.tables.splice(ti, 1); return s; }), `Remove ${t.title}`)}
                      </>
                    ) : (
                      <>
                        <b className="t-body" style={{ flex: 1 }}>{t.title}</b>
                        <button type="button" className="btn link"
                          onClick={() => up((s) => { s.tables[ti].rows.forEach((r) => { if (r.value.trim()) r.verdict = "Pass"; }); return s; })}>
                          All filled rows pass
                        </button>
                      </>
                    )}
                  </div>
                  <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 4 }}>
                    <thead>
                      <tr className="t-meta" style={{ background: "var(--t-neutral-bg)" }}>
                        <th style={{ padding: 4, textAlign: "left" }}>{t.cols[0]}</th>
                        <th style={{ padding: 4, textAlign: "left" }}>{t.cols[1]}</th>
                        <th style={{ padding: 4, textAlign: "left" }}>{editing ? "" : "Pass/Fail"}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {t.rows.map((r, ri) => (
                        <tr key={r.id} style={{ borderTop: "1px solid var(--line)" }}>
                          <td style={{ padding: 4 }}>
                            {editing
                              ? <input value={r.point} aria-label="Point" className="mono" style={{ width: 88 }}
                                  onChange={(e) => up((s) => { s.tables[ti].rows[ri].point = e.target.value; return s; })} />
                              : <span className="mono">{r.point}</span>}
                          </td>
                          <td style={{ padding: 4 }}>
                            {editing ? <span className="mut t-meta">filled in on site</span> : (
                              <input value={r.value} placeholder="e.g. 6.50E+07" aria-label={`${t.title} ${r.point}`}
                                className="mono" style={{ width: "100%", minWidth: 96 }}
                                onChange={(e) => up((s) => { s.tables[ti].rows[ri].value = e.target.value; return s; })} />
                            )}
                          </td>
                          <td style={{ padding: 4 }}>
                            {editing ? x(() => up((s) => { s.tables[ti].rows.splice(ri, 1); return s; }), `Remove ${r.point}`) : (
                              <div className="seg" role="group" aria-label={`${r.point} result`}>
                                {(["Pass", "Fail"] as const).map((o) => (
                                  <button key={o} type="button" aria-pressed={r.verdict === o}
                                    onClick={() => up((s) => { const row = s.tables[ti].rows[ri]; row.verdict = row.verdict === o ? "" : o; return s; })}>{o}</button>
                                ))}
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {editing && (
                    <button type="button" className="btn link" style={{ marginTop: 4 }}
                      onClick={() => up((s) => { s.tables[ti].rows.push({ id: nid(), point: "", value: "", verdict: "" }); return s; })}>＋ row</button>
                  )}
                </div>
              ))}
              {editing && (
                <button type="button" className="btn sm"
                  onClick={() => up((s) => {
                    s.tables.push({ id: nid(), title: "New table", cols: ["Mass (Da)", "m/z Intensity Measured"], rows: [{ id: nid(), point: "", value: "", verdict: "" }] });
                    return s;
                  })}>
                  ＋ Table
                </button>
              )}
              {!editing && sheet.tables.length === 0 && <div className="mut t-small">No tables on this sheet.</div>}
            </div>
          </div>

          {/* Footer */}
          <div className="row-2" style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--line)", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {editing ? (
              <>
                <button type="button" className="btn sm accent"
                  onClick={() => { setSaved(`Saved as the sheet for every Waters Quattro Ultima. The next PM starts from it.`); setEditing(false); }}>
                  Save for every Quattro Ultima
                </button>
                <button type="button" className="btn sm"
                  onClick={() => { setSaved("Changed on this job only."); setEditing(false); }}>
                  Just this job
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn sm" onClick={preview}>Preview PDF</button>
                <button type="button" className="btn sm accent" disabled={progress.done === 0}
                  onClick={() => setSaved("In the real thing this issues the numbered report, e.g. 030190_PM1.")}>
                  Issue service report
                </button>
                <button type="button" className="btn link" onClick={() => { setSheet(null); setSaved(""); }}>Start over</button>
              </>
            )}
            {saved && <span className="mut t-small">{saved}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
