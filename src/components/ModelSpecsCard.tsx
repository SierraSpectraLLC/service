"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setModelSpecs, setSeriesSpecs } from "@/app/actions";
import Dialog from "@/components/ui/Dialog";
import { toast } from "@/components/ui/Toast";
import { effectiveSheet, MAX_SPECS, mergeModelSpecs, type SheetRow, type Spec } from "@/lib/modelSpecs";

/**
 * The model's spec sheet: max pressure, flow range, operating temperature -
 * whatever rows this model deserves, named freely, suggested from what sibling
 * models already use so spellings converge.
 *
 * A model in a family reads the family's sheet first (lib/modelSpecs
 * .effectiveSheet): every ISQ shows the ISQ numbers, and this model's own rows
 * are only the ones that differ. Two editors follow from that. "Edit specs"
 * works on the merged sheet - change a shared value here and it becomes this
 * model's own; blank it and it goes back to the family's. "Edit the family
 * sheet" changes every member at once, and is where a spec is added to or
 * taken off all of them.
 *
 * "Copy from" pulls another model's sheet in to fill the blanks - a G7116B
 * starts as a G7116A and gets its differences edited by hand, which is the
 * whole reason the sheet exists. Copying never overwrites a row already here.
 */
export default function ModelSpecsCard({
  termId, modelName, specs, series = "", seriesSpecs = [], seriesMembers = [], siblings, nameSuggestions,
}: {
  termId: number;
  modelName: string;
  /** This model's OWN rows - what differs from the family, or everything when it is in none. */
  specs: Spec[];
  /** The family the model is in - "ISQ". Blank = none. */
  series?: string;
  /** The family's sheet, as stored. */
  seriesSpecs?: Spec[];
  /** The other models the family sheet reaches, so the editor can say so. */
  seriesMembers?: string[];
  /** Same-type models that have sheets of their own, offered as copy sources. */
  siblings: { name: string; specs: Spec[] }[];
  nameSuggestions: string[];
}) {
  const router = useRouter();
  const [editing, setEditing] = useState<"model" | "series" | null>(null);
  const [rows, setRows] = useState<Spec[]>(specs);
  const [copyFrom, setCopyFrom] = useState("");
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();

  const sheet = effectiveSheet(specs, seriesSpecs);
  const inherited = sheet.filter((r) => r.source === "series").length;
  const overridden = sheet.filter((r) => r.source === "override").length;
  const shared = new Map(seriesSpecs.map((s) => [s.name.trim().toLowerCase(), s.value]));

  const startEdit = (what: "model" | "series") => {
    const base = what === "series" ? seriesSpecs : sheet.map(({ name, value }) => ({ name, value }));
    setRows(base.length ? base.map((s) => ({ ...s })) : [{ name: "", value: "" }]);
    setError("");
    setEditing(what);
  };
  const setRow = (i: number, patch: Partial<Spec>) =>
    setRows((rs) => rs.map((r, n) => (n === i ? { ...r, ...patch } : r)));

  const copy = (name: string) => {
    setCopyFrom("");
    const src = siblings.find((s) => s.name === name);
    if (!src) return;
    setRows((rs) => mergeModelSpecs(rs.filter((r) => r.name.trim() && r.value.trim()), src.specs));
  };

  const save = () => {
    setError("");
    const what = editing;
    startTransition(async () => {
      const res = what === "series" ? await setSeriesSpecs(termId, rows) : await setModelSpecs(termId, rows);
      if (res?.error) { setError(res.error); return; }
      setEditing(null);
      toast({ message: what === "series" ? `Saved the ${series} sheet for every ${series}` : "Saved the specs" });
      router.refresh();
    });
  };

  // In the model editor, a row the family defines keeps its name: the row can
  // take a different value or go back to the family's, but it cannot be
  // removed from one model - that is an edit to the family sheet.
  const familyValue = (name: string) => (editing === "model" ? shared.get(name.trim().toLowerCase()) : undefined);

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
        <div className="card-title">Specifications</div>
        {editing === null && (
          <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {series && (
              <button className="btn sm" onClick={() => startEdit("series")}>
                {seriesSpecs.length ? `Edit the ${series} sheet` : `+ Add ${series} specs`}
              </button>
            )}
            <button className="btn sm" onClick={() => startEdit("model")}>
              {sheet.length ? "Edit" : "+ Add specs"}
            </button>
          </span>
        )}
      </div>
      <div className="mut t-meta" style={{ marginBottom: 8 }}>
        {series ? (
          <>
            Every <b>{series}</b> shares the {series} sheet
            {seriesMembers.length ? ` (${seriesMembers.join(", ")} too)` : " (this is the only model in it so far)"}.
            {" "}What differs on a {modelName} is written on the {modelName} alone.
          </>
        ) : (
          <>The numbers you&apos;d otherwise open the manual for. Rows are yours to define - add what matters for a {modelName}.</>
        )}
      </div>

      {editing === null && sheet.length > 0 && <SheetTable rows={sheet} series={series} />}
      {editing === null && sheet.length > 0 && series && (
        <div className="mut t-meta" style={{ marginTop: 8 }}>
          {inherited > 0 && <>{inherited} from the {series} sheet</>}
          {inherited > 0 && overridden > 0 && " · "}
          {overridden > 0 && <>{overridden} where the {modelName} differs</>}
          {(inherited > 0 || overridden > 0) && sheet.length - inherited - overridden > 0 && " · "}
          {sheet.length - inherited - overridden > 0 && <>{sheet.length - inherited - overridden} only on the {modelName}</>}
        </div>
      )}
      {editing === null && sheet.length === 0 && (
        <div className="mut t-small">
          No specs recorded yet{series
            ? ` - write the shared numbers on the ${series} sheet once, and every ${series} has them`
            : siblings.length ? " - or start by copying a sibling's sheet and editing the differences" : ""}.
        </div>
      )}

      {editing !== null && (
        <Dialog open onClose={() => setEditing(null)}
          title={editing === "series" ? `Edit the ${series} sheet` : "Edit specs"}
          footer={
            <>
              <span className={`dialog-status${error ? " err" : ""}`}>{error}</span>
              <button className="btn" onClick={() => setEditing(null)} disabled={pending}>Cancel</button>
              <button className="btn accent" onClick={save} disabled={pending}>
                {pending ? "Saving..." : editing === "series" ? `Save for every ${series}` : "Save specs"}
              </button>
            </>
          }>
          {editing === "series" && (
            <div className="mut t-meta" style={{ marginBottom: 8 }}>
              These rows show on every {series}
              {seriesMembers.length ? `: ${[modelName, ...seriesMembers].join(", ")}` : ""}.
              A model that says a different value keeps its own.
            </div>
          )}
          {editing === "model" && series && seriesSpecs.length > 0 && (
            <div className="mut t-meta" style={{ marginBottom: 8 }}>
              Rows marked <i>{series}</i> come from the family sheet. Change one and the {modelName} keeps its own value;
              clear it to go back to the family&apos;s. To add a row to every {series} or take one away, edit the {series} sheet instead.
            </div>
          )}
          {siblings.length > 0 && (
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
              <select value={copyFrom} onChange={(e) => copy(e.target.value)} className="t-small" style={{ width: "auto" }}
                aria-label="Copy specs from">
                <option value="">Copy from...</option>
                {siblings.map((s) => <option key={s.name} value={s.name}>{s.name} ({s.specs.length} rows)</option>)}
              </select>
              <span className="mut t-meta">Fills rows you don&apos;t have; never overwrites yours.</span>
            </div>
          )}
          {rows.map((r, i) => {
            const fromFamily = familyValue(r.name);
            const differs = fromFamily !== undefined && r.value.trim() !== "" && r.value.trim() !== fromFamily;
            return (
              <div key={i} style={{ marginBottom: 6 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <input value={r.name} list="spec-names" placeholder='e.g. "Max pressure"'
                    aria-label={`Spec name, row ${i + 1}`}
                    readOnly={fromFamily !== undefined}
                    onChange={(e) => setRow(i, { name: e.target.value })}
                    className="t-body" style={{ flex: "0 1 220px" }} />
                  <input value={r.value} placeholder={fromFamily !== undefined ? fromFamily : 'e.g. "1300 bar"'}
                    aria-label={`Spec value, row ${i + 1}`}
                    onChange={(e) => setRow(i, { value: e.target.value })}
                    onKeyDown={(e) => { if (e.key === "Enter" && i === rows.length - 1 && rows.length < MAX_SPECS) setRows((rs) => [...rs, { name: "", value: "" }]); }}
                    className="t-body" style={{ flex: "1 1 200px" }} />
                  {fromFamily === undefined ? (
                    <button className="btn link" aria-label={`Remove row ${i + 1}`} style={{ color: "var(--t-bad-fg)" }}
                      onClick={() => setRows((rs) => rs.filter((_, n) => n !== i))}>×</button>
                  ) : (
                    <span className="mut t-meta" style={{ whiteSpace: "nowrap" }}>{series}</span>
                  )}
                </div>
                {differs && (
                  <div className="mut t-meta" style={{ paddingLeft: 2, marginTop: 2 }}>
                    the {series} sheet says {fromFamily} ·{" "}
                    <button className="btn link" onClick={() => setRow(i, { value: fromFamily })}>use that</button>
                  </div>
                )}
              </div>
            );
          })}
          <datalist id="spec-names">{nameSuggestions.map((n) => <option key={n} value={n} />)}</datalist>
          {rows.length < MAX_SPECS && (
            <button className="btn sm" style={{ marginTop: 4 }} onClick={() => setRows((rs) => [...rs, { name: "", value: "" }])}>＋ Row</button>
          )}
        </Dialog>
      )}
    </div>
  );
}

/**
 * The merged sheet with each row's origin beside it - SpecTable plus one
 * column, kept here because only the model's own page has reason to show
 * where a number came from. A unit page just needs the number.
 */
function SheetTable({ rows, series }: { rows: SheetRow[]; series: string }) {
  return (
    <table style={{ borderCollapse: "collapse", width: "100%", maxWidth: 640 }}>
      <tbody>
        {rows.map((r) => (
          <tr key={r.name}>
            <td className="mut t-small" style={{
              padding: "5px 14px 5px 0", borderTop: "1px solid var(--line)", whiteSpace: "nowrap", verticalAlign: "top",
            }}>{r.name}</td>
            <td className="t-body" style={{ fontWeight: 600, padding: "5px 14px 5px 0", borderTop: "1px solid var(--line)" }}>
              {r.value}
            </td>
            {series && (
              <td className="mut t-meta" style={{ padding: "5px 0", borderTop: "1px solid var(--line)", whiteSpace: "nowrap", textAlign: "right" }}
                title={r.source === "override" ? `The ${series} sheet says ${r.seriesValue}` : undefined}>
                {r.source === "series" ? series : r.source === "override" ? `differs from ${series}` : "this model only"}
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
