"use client";

import { useState, useTransition } from "react";
import { createAssets, type AssetInput } from "@/app/actions";
import { toast } from "@/components/ui/Toast";
import { toCsv } from "@/lib/csv";
import { orgNamed, type OrgLite } from "@/lib/owner";

/** One catalog model, with the maker so picking a model fills it in. */
export type GridModel = { name: string; manufacturer: string };

type Row = {
  kind: string; model: string; serial: string; manufacturer: string;
  owner: string; location: string; asFound: string; note: string;
  /**
   * What this unit serves: "row:N" for another row of this grid (0-based),
   * "asset:ID" for a module already on the system, "" for nothing in
   * particular. Not a template column - the CSV round-trip has no rows to
   * point at - so it sits outside COLUMNS and is never pasted into.
   */
  serves: string;
};

/** A module already on the system that a new row may serve. */
export type ServeTarget = { id: number; label: string };

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
  kind, model: "", serial: "", manufacturer: "", owner: "", location: "", asFound: "", note: "", serves: "",
});

/** What a row is called from another row's Serves picker. */
const rowName = (r: Row, i: number) => `Row ${i + 1} · ${[r.kind, r.model || r.serial].filter(Boolean).join(" ")}`;

const filled = (r: Row) => !!(r.kind.trim() && (r.model.trim() || r.serial.trim()));

/**
 * Spreadsheet-shaped asset entry: a row per unit, a column per field, catalog
 * dropdowns where a value has to come from the catalog. Seven LC modules is one
 * screen and one Save, not seven trips through a form.
 *
 * Paste works: copy a block out of Excel or Sheets and it fills the grid from
 * the focused cell, which is the whole point of matching the template's columns.
 *
 * On a system the grid has one more column, Serves: a mass spec and its two
 * roughing pumps go in together, each pump naming the spec's row, and the
 * stack lands plumbed in one Save rather than three trips through the pumps'
 * pages afterwards. See lib/assetServes.
 */
export default function AssetGrid({ instrumentId, kinds, models, owners, existing = [], onDone }: {
  /** Null for shelf stock; a system id installs every row onto it. */
  instrumentId: number | null;
  kinds: string[];
  /** Catalog models per asset type, each with its maker. */
  models: Record<string, GridModel[]>;
  /** The organizations a unit may belong to - see lib/owner.ownerChoices. */
  owners: OrgLite[];
  /** Modules already on the system a new row may serve (none that serve something themselves). */
  existing?: ServeTarget[];
  onDone?: () => void;
}) {
  const [rows, setRows] = useState<Row[]>([blank(kinds[0] ?? ""), blank(kinds[0] ?? ""), blank(kinds[0] ?? "")]);
  const [error, setError] = useState("");
  const [failures, setFailures] = useState<{ row: number; error: string }[]>([]);
  const [unlinked, setUnlinked] = useState<{ row: number; error: string }[]>([]);
  const [saved, setSaved] = useState("");
  const [pending, startTransition] = useTransition();

  const setCell = (i: number, key: keyof Row, value: string) =>
    setRows((rs) => rs.map((r, n) => {
      if (n !== i) return r;
      const next = { ...r, [key]: value };
      // A row that now serves something can no longer be served: clear any
      // pick pointing at it, so depth stays at one on the grid as in the rules.
      if (key === "serves" && value) {
        return next;
      }
      // Picking a catalog model fills the maker in - it's known, so nobody
      // should be typing "Shimadzu" thirty times. A maker already typed stands.
      if (key === "model") {
        const hit = (models[r.kind] ?? []).find((m) => m.name === value);
        if (hit?.manufacturer && !r.manufacturer.trim()) next.manufacturer = hit.manufacturer;
      }
      // Changing the type invalidates the model beneath it.
      if (key === "kind" && value !== r.kind) { next.model = ""; next.manufacturer = ""; }
      return next;
    }).map((r) => (key === "serves" && value && r.serves === `row:${i}` ? { ...r, serves: "" } : r)));

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
  const plumbed = instrumentId !== null;

  /** Drop a row, and keep every other row's Serves pointing where it did. */
  const removeRow = (at: number) =>
    setRows((rs) => rs.filter((_, n) => n !== at).map((r) => {
      if (!r.serves.startsWith("row:")) return r;
      const n = parseInt(r.serves.slice(4), 10);
      return { ...r, serves: n === at ? "" : n > at ? `row:${n - 1}` : r.serves };
    }));

  // A pump pointed at a row that is not going to be saved - blanked since it
  // was picked, or never filled - is caught here, before anything is written.
  const danglingServes = rows.findIndex((r, i) =>
    filled(r) && r.serves.startsWith("row:") && !filled(rows[parseInt(r.serves.slice(4), 10)] ?? blank()) && i >= 0);

  const save = () => {
    setError(""); setFailures([]); setUnlinked([]); setSaved("");
    if (danglingServes >= 0) {
      setError(`Row ${danglingServes + 1} serves a row that is empty - fill it in or clear the Serves pick.`);
      return;
    }
    startTransition(async () => {
      // An owner that names one of the offered organizations is that
      // organization - the link travels with the name, so the client can
      // actually open what the row says is theirs. A Serves pick names a row
      // by its place among the rows being SAVED, which is what the action
      // numbers, not its place on the grid.
      const usableAt = new Map(rows.map((r, i) => [i, usable.indexOf(r)] as const));
      const input: AssetInput[] = usable.map(({ serves, ...r }) => ({
        ...r, ownerOrgId: orgNamed(r.owner, owners)?.id ?? null,
        servesRow: plumbed && serves.startsWith("row:") ? (usableAt.get(parseInt(serves.slice(4), 10)) ?? -1) + 1 : null,
        servesAssetId: plumbed && serves.startsWith("asset:") ? parseInt(serves.slice(6), 10) : null,
      }));
      const res = await createAssets(instrumentId, input);
      if (res?.error) { setError(res.error); return; }
      setFailures(res.failures ?? []);
      setUnlinked(res.linkFailures ?? []);
      setSaved(`${res.created} asset${res.created === 1 ? "" : "s"} added`);
      if (res.created) toast({ message: `Added ${res.created} asset${res.created === 1 ? "" : "s"}` });
      // Keep only the rows that failed, so a fix is a retry rather than a
      // retype - minus their Serves picks, which named rows that are gone.
      const bad = new Set((res.failures ?? []).map((f) => f.row));
      setRows(bad.size
        ? usable.filter((_, i) => bad.has(i + 1)).map((r) => ({ ...r, serves: "" }))
        : [blank(kinds[0] ?? ""), blank(kinds[0] ?? ""), blank(kinds[0] ?? "")]);
      if (!bad.size && !(res.linkFailures ?? []).length) onDone?.();
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
        <table className="t-small" style={{ borderCollapse: "collapse", minWidth: 880 }}>
          <thead>
            <tr>
              <th style={{ width: 26 }} />
              {COLUMNS.map((c) => (
                <th key={c.key} className="t-meta" style={{ textAlign: "left", padding: "6px 6px", borderBottom: "1px solid var(--line)", color: "var(--slate)", width: c.width }}>
                  {c.label}{(c.key === "kind") && " *"}
                </th>
              ))}
              {plumbed && (
                <th className="t-meta" style={{ textAlign: "left", padding: "6px 6px", borderBottom: "1px solid var(--line)", color: "var(--slate)", width: 150 }}>
                  Serves
                </th>
              )}
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
                        className="t-small" style={{ width: "100%", padding: "3px 4px" }}>
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
                          className="t-small" style={{ width: "100%", padding: "3px 4px" }} />
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
                        className="t-small" style={{ width: "100%", padding: "3px 4px" }} />
                    ) : (
                      <input value={r[c.key]} aria-label={`${c.label}, row ${i + 1}`}
                        className={"mono" in c && c.mono ? "mono t-small" : "t-small"}
                        onChange={(e) => setCell(i, c.key, e.target.value)}
                        onPaste={(e) => onPaste(e, i, ci)}
                        style={{ width: "100%", padding: "3px 4px" }} />
                    )}
                  </td>
                ))}
                {plumbed && (
                  <td style={{ padding: 2, borderBottom: "1px solid var(--line)" }}>
                    {/* Other filled rows that are not themselves serving
                        something (depth stays at one), then the modules
                        already on the system. Nothing to offer reads as a
                        dash, not an empty select. */}
                    {(() => {
                      const peers = rows.map((o, n) => ({ o, n }))
                        .filter(({ o, n }) => n !== i && filled(o) && !o.serves);
                      if (!peers.length && !existing.length) return <span className="mut t-meta">-</span>;
                      return (
                        <select value={r.serves} aria-label={`Serves, row ${i + 1}`}
                          onChange={(e) => setCell(i, "serves", e.target.value)}
                          className="t-small" style={{ width: "100%", padding: "3px 4px" }}>
                          <option value="">-</option>
                          {peers.length > 0 && (
                            <optgroup label="In this batch">
                              {peers.map(({ o, n }) => <option key={n} value={`row:${n}`}>{rowName(o, n)}</option>)}
                            </optgroup>
                          )}
                          {existing.length > 0 && (
                            <optgroup label="Already on the system">
                              {existing.map((x) => <option key={x.id} value={`asset:${x.id}`}>{x.label}</option>)}
                            </optgroup>
                          )}
                        </select>
                      );
                    })()}
                  </td>
                )}
                <td style={{ padding: 2, borderBottom: "1px solid var(--line)" }}>
                  {rows.length > 1 && (
                    <button className="btn link t-small" aria-label={`Remove row ${i + 1}`} style={{ color: "var(--t-bad-fg)" }}
                      onClick={() => removeRow(i)}>×</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* The organizations we work with, as a datalist rather than a select:
          a company not on the platform is still a legitimate owner, typed. */}
      <datalist id="grid-owners">{owners.map((o) => <option key={o.id} value={o.name} />)}</datalist>

      <div className="row-2" style={{ marginTop: 8 }}>
        <button className="btn sm" onClick={() => setRows((rs) => [...rs, blank(kinds[0] ?? "")])}>＋ Row</button>
        <button className="btn sm" onClick={() => setRows((rs) => [...rs, ...Array.from({ length: 5 }, () => blank(kinds[0] ?? ""))])}>＋ 5</button>
        <a className="btn link t-small"
          href={"data:text/csv;charset=utf-8," + encodeURIComponent(template())}
          download="assets-template.csv">download template</a>
        <span className="mut t-meta">
          Paste a block from a spreadsheet into any cell - same columns, in order.
          {plumbed && " Serves: a pump names the row of the module it serves, and the stack lands plumbed."}
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
      {unlinked.length > 0 && (
        <div className="t-small" style={{ color: "var(--t-warn-fg)", marginTop: 8 }}>
          Saved, but not plumbed as asked - set it on the unit&apos;s own page:
          <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
            {unlinked.map((f) => <li key={f.row}>Row {f.row}: {f.error}</li>)}
          </ul>
        </div>
      )}
      {error && <div className="t-small" style={{ color: "var(--t-bad-fg)", marginTop: 8 }}>{error}</div>}
    </div>
  );
}
