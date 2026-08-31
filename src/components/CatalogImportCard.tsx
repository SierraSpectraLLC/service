"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { importCatalog } from "@/app/actions";
import { parseCsv, toCsv } from "@/lib/csv";
import {
  COLUMNS, needsReading, planCatalogImport, readGrid, templateGrid, writesSomething,
  type CatalogImportRow, type ExistingModel, type Verdict,
} from "@/lib/catalogImport";
import { Panel, Pill } from "@/components/ui";
import type { Tone } from "@/lib/tones";
import { toast } from "@/components/ui/Toast";

/** What each verdict is called on screen, and how loudly. */
const VERDICT: Record<Verdict, { label: string; tone: Tone }> = {
  new: { label: "new", tone: "good" },
  merge: { label: "widened", tone: "info" },
  same: { label: "unchanged", tone: "faint" },
  repeat: { label: "repeat", tone: "faint" },
  oem: { label: "new OEM", tone: "good" },
  nearby: { label: "another spelling", tone: "warn" },
  conflict: { label: "disagrees", tone: "warn" },
  problem: { label: "unusable", tone: "bad" },
};

/**
 * A whole catalog sheet - modules and OEMs - in one go.
 *
 * Four steps in the order somebody does them: take what is already on file (so
 * the shape is not guessed at), put the sheet in, LOOK at what every line was
 * decided to be, then save. The look is the reason this is a card and not a
 * file input: on two thousand lines the interesting number is never how many
 * models there are, it is how many the catalog already had - and a person has
 * to see that before they agree to it, not in a toast afterwards.
 *
 * The verdicts come from lib/catalogImport, the same function the server runs
 * again when it writes, so the preview cannot promise something the save does
 * not do.
 */
export default function CatalogImportCard({ models, moduleTypes, systemTypes, makers }: {
  models: ExistingModel[];
  moduleTypes: string[];
  systemTypes: string[];
  makers: string[];
}) {
  const [rows, setRows] = useState<CatalogImportRow[] | null>(null);
  const [done, setDone] = useState<{ line: number; model: string; problem: string }[] | null>(null);
  const [saving, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pasted, setPasted] = useState("");

  const plan = useMemo(
    () => (rows?.length ? planCatalogImport(rows, { models, moduleTypes, systemTypes, makers }) : null),
    [rows, models, moduleTypes, systemTypes, makers],
  );

  const take = (text: string) => {
    // Tab-separated is what a paste out of Excel is; comma is what a file is.
    // Sniffing beats asking, and getting it wrong is obvious in the preview.
    const grid = text.includes("\t")
      ? text.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split("\t"))
      : parseCsv(text);
    const read = readGrid(grid);
    setRows(read);
    setDone(null);
    if (!read.length) toast({ message: "Nothing readable on that sheet", tone: "bad" });
  };

  const reset = () => {
    setRows(null);
    setPasted("");
    if (fileRef.current) fileRef.current.value = "";
  };

  const save = () => {
    if (!rows?.length) return;
    start(async () => {
      const res = await importCatalog(rows);
      if (res.error) { toast({ message: res.error, tone: "bad" }); return; }
      const bits = [
        res.models ? `${res.models} model${res.models === 1 ? "" : "s"}` : "",
        res.merged ? `${res.merged} widened` : "",
        res.makers ? `${res.makers} OEM${res.makers === 1 ? "" : "s"}` : "",
        res.moduleTypes ? `${res.moduleTypes} module type${res.moduleTypes === 1 ? "" : "s"}` : "",
        res.systemTypes ? `${res.systemTypes} system type${res.systemTypes === 1 ? "" : "s"}` : "",
      ].filter(Boolean).join(", ");
      toast({ message: bits ? `Imported: ${bits}` : "Nothing to change - it was all on file" });
      // The rows go, the review list stays: a summary that disappears with the
      // thing it is about is a summary nobody can act on.
      setDone(res.skipped ?? []);
      reset();
    });
  };

  const willWrite = plan ? plan.rows.filter((p) => writesSomething(p.verdict)).length : 0;
  const toRead = plan ? plan.rows.filter((p) => needsReading(p.verdict)) : [];
  const review = done ?? toRead.map((p) => ({ line: p.line, model: p.row.model || p.row.manufacturer, problem: p.note ?? p.verdict }));

  return (
    <Panel
      title="Import modules &amp; OEMs"
      actions={
        <>
          {/* Export first, deliberately: for a catalog with anything in it the
              honest starting point is what is already there, not a blank
              template - and it is the file the new models get typed under. */}
          <a className="btn sm" href="/api/export/catalog">Export what is on file</a>
          <a className="btn sm" download="equipment-catalog-template.csv"
            href={"data:text/csv;charset=utf-8," + encodeURIComponent(toCsv(templateGrid()))}>
            Download template
          </a>
        </>
      }
    >
      <div className="t-body" style={{ marginBottom: 10 }}>
        One line per module. A model that serves two platforms is one line with
        both system types, semicolon-separated - not two lines.
        {" "}<b>Nothing already in the catalog is overwritten</b>: a model on file
        gains system types it did not carry and a maker where it had none, and a
        line that disagrees with what somebody set is listed for you rather than
        applied. A line with a manufacturer and no model just adds that OEM to
        the book.
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        <input ref={fileRef} type="file" accept=".csv,text/csv" className="t-small"
          aria-label="Choose a CSV file"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void f.text().then(take); }} />
      </div>
      <div className="field" style={{ marginBottom: 10 }}>
        <label htmlFor="catalog-paste">...or paste straight out of a spreadsheet</label>
        <textarea id="catalog-paste" rows={3} value={pasted}
          placeholder={COLUMNS.map((c) => c.header.split("(")[0].trim()).join("\t")}
          onChange={(e) => setPasted(e.target.value)}
          onBlur={() => pasted.trim() && take(pasted)} />
      </div>

      {plan && rows && rows.length > 0 && (
        <>
          {/* The line that decides whether somebody presses the button. On two
              thousand rows the interesting number is what the catalog ALREADY
              had, which is invisible in the file itself. */}
          <div className="t-body" style={{ marginBottom: 8 }}>
            <b>{rows.length}</b> line{rows.length === 1 ? "" : "s"} read.{" "}
            <b>{willWrite}</b> would be written;{" "}
            <b>{plan.counts.same + plan.counts.repeat}</b> already on file.
          </div>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 8 }}>
            {(Object.keys(VERDICT) as Verdict[]).filter((v) => plan.counts[v] > 0).map((v) => (
              <Pill key={v} tone={VERDICT[v].tone}>{plan.counts[v]} {VERDICT[v].label}</Pill>
            ))}
          </div>
          {(plan.newModuleTypes.length > 0 || plan.newSystemTypes.length > 0 || plan.newMakers.length > 0) && (
            /* Said before the save, because these are catalog-wide: a sheet
               that invents six module types changes every picker in the app. */
            <div className="mut t-small" style={{ marginBottom: 8 }}>
              Also creates{" "}
              {[
                plan.newModuleTypes.length ? `${plan.newModuleTypes.length} module type${plan.newModuleTypes.length === 1 ? "" : "s"} (${plan.newModuleTypes.slice(0, 6).join(", ")}${plan.newModuleTypes.length > 6 ? "..." : ""})` : "",
                plan.newSystemTypes.length ? `${plan.newSystemTypes.length} system type${plan.newSystemTypes.length === 1 ? "" : "s"} (${plan.newSystemTypes.slice(0, 6).join(", ")}${plan.newSystemTypes.length > 6 ? "..." : ""})` : "",
                plan.newMakers.length ? `${plan.newMakers.length} OEM${plan.newMakers.length === 1 ? "" : "s"}` : "",
              ].filter(Boolean).join("; ")}.
            </div>
          )}

          <div style={{ overflowX: "auto", border: "1px solid var(--line)", borderRadius: 8 }}>
            <table className="t-small" style={{ borderCollapse: "collapse", minWidth: "100%" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: "5px 8px", whiteSpace: "nowrap", borderBottom: "1px solid var(--line)" }}>Line</th>
                  {COLUMNS.map((c) => (
                    <th key={c.key} style={{ textAlign: "left", padding: "5px 8px", whiteSpace: "nowrap", borderBottom: "1px solid var(--line)" }}>
                      {c.header.split("(")[0].trim()}
                    </th>
                  ))}
                  <th style={{ textAlign: "left", padding: "5px 8px", whiteSpace: "nowrap", borderBottom: "1px solid var(--line)" }}>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {/* Everything that needs reading first, then the rest: on a long
                    sheet the twelve lines somebody has to look at must not be
                    somewhere past row four hundred. */}
                {[...plan.rows].sort((a, b) =>
                  Number(needsReading(b.verdict)) - Number(needsReading(a.verdict)) || a.line - b.line,
                ).slice(0, 25).map((p) => (
                  <tr key={p.line}>
                    <td className="mut" style={{ padding: "4px 8px", borderTop: "1px solid var(--line)" }}>{p.line}</td>
                    {COLUMNS.map((c) => (
                      <td key={c.key} style={{ padding: "4px 8px", whiteSpace: "nowrap", borderTop: "1px solid var(--line)" }}>
                        {p.row[c.key]}
                      </td>
                    ))}
                    <td style={{ padding: "4px 8px", borderTop: "1px solid var(--line)" }}>
                      <Pill tone={VERDICT[p.verdict].tone}>{VERDICT[p.verdict].label}</Pill>
                      {p.note && <span className="mut t-meta" style={{ marginLeft: 6 }}>{p.note}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {plan.rows.length > 25 && (
            <div className="mut t-meta" style={{ marginTop: 5 }}>
              Showing 25 of {plan.rows.length}, anything needing a look first.
            </div>
          )}

          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button className="btn primary" disabled={saving || willWrite === 0} onClick={save}>
              {saving ? "Importing…" : willWrite === 0 ? "Nothing to import" : `Import ${willWrite} line${willWrite === 1 ? "" : "s"}`}
            </button>
            <button className="btn" disabled={saving} onClick={reset}>Discard</button>
          </div>
        </>
      )}

      {review.length > 0 && (
        /* By line, because the fix happens in their spreadsheet and a line
           number is the only address that means anything there. */
        <div className="t-small" style={{ marginTop: 10, padding: "8px 10px", borderRadius: 8, background: "var(--t-warn-bg)", color: "var(--t-warn-fg)" }}>
          <b>{review.length} line{review.length === 1 ? "" : "s"} {done ? "were left alone" : "need a look"}.</b>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {review.slice(0, 10).map((p) => (
              <li key={p.line}>Line {p.line}{p.model ? ` (${p.model})` : ""} - {p.problem}</li>
            ))}
          </ul>
          {review.length > 10 && <div style={{ marginTop: 4 }}>...and {review.length - 10} more.</div>}
        </div>
      )}
    </Panel>
  );
}
